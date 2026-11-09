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
import { checkMacUpdate, macBundleProblem, macZipProblem, zipListingRows, zipNames, appUpdateFeed } from '../../src/main/core/update-verify.mjs';
import { installerVersionProblem } from '../../src/main/core/update-model.mjs';
import { UPDATE_CODES } from '../../src/main/core/update-signature.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const FEED = 'https://dist.example/u';
const bundle = (version, extra = {}) => ({ name: 'SSAM Agent', identifier: 'com.ssam.agent', shortVersion: version, bundleVersion: version, feed: FEED, ...extra });

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

// Review M1-R2: a fake /usr/bin/unzip and /usr/bin/plutil over a list of ZIP entries ([type, name]: 'd' directory, '-' file,
// 'l' symlink). The `unzip -Z` rows are in the format of a real ZIP of the app made by electron-builder (7za) in the Mac CI
// (0.2.5 test build, 130 entries, 14 symlinks: `drwxr-xr-x  3.0 unx        0 bx stor 26-Nov-03 15:16 SSAM Agent.app/`);
// macZipProblem accepts that whole ZIP as listed by Info-ZIP UnZip 6.00 (evidence of the R3 round: mac-028/logs/m1r2-real-zip-gate.log).
const ROOT = 'SSAM Agent.app';
const realTree = () => [
  ['d', ROOT + '/'], ['d', ROOT + '/Contents/'], ['-', ROOT + '/Contents/Info.plist'], ['d', ROOT + '/Contents/MacOS/'], ['-', ROOT + '/Contents/MacOS/SSAM Agent'],
  ['d', ROOT + '/Contents/Resources/'], ['-', ROOT + '/Contents/Resources/app-update.yml'], ['-', ROOT + '/Contents/Resources/app.asar'],
  ['d', ROOT + '/Contents/Frameworks/'], ['d', ROOT + '/Contents/Frameworks/Electron Framework.framework/'],
  ['l', ROOT + '/Contents/Frameworks/Electron Framework.framework/Electron Framework'], ['l', ROOT + '/Contents/Frameworks/Electron Framework.framework/Resources'],
  ['-', ROOT + '/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'],
];
const MODES = { d: 'drwxr-xr-x', '-': '-rw-r--r--', l: 'lrwxr-xr-x' };
const plistJson = (version, extra = {}) => JSON.stringify({ CFBundleIdentifier: 'com.ssam.agent', CFBundleName: 'SSAM Agent', CFBundleShortVersionString: version, CFBundleVersion: version, LSUIElement: true, CFBundleURLTypes: [{ CFBundleURLName: 'nested' }], ...extra });
// structure: what core/zip-structure.mjs answers for those entries (review M-R3-1); a symlink points inside its framework
// (Versions/Current/<name>, as in the real ZIP) unless links says otherwise.
function zipTool(entries, { plistText = infoPlist('0.2.9'), plutil = () => plistJson('0.2.9'), yml = `owner: ssam\nurl: ${FEED}\nchannel: latest\nupdaterCacheDirName: ssam-agent-updater\n`, header = null, names = null, links = {}, structure = null } = {}) {
  const calls = []; const plutilInputs = [];
  const own = structure ?? { entries: entries.map(([type, name]) => ({ name: name.replace(/\/$/, type === 'd' ? '/' : ''), type, link: type === 'l' ? (name in links ? links[name] : 'Versions/Current/' + name.split('/').pop()) : null })) };
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/unzip' && args[0] === '-Z1') return (names ?? entries.map(e => e[1])).join('\n') + '\n';
    if (cmd === '/usr/bin/unzip' && args[0] === '-Z') return `Archive:  ${args[1]}\nZip file size: 129468071 bytes, number of entries: ${header ?? entries.length}\n`
      + entries.map(([type, name]) => `${MODES[type]}  3.0 unx     3848 bX defN 26-Nov-03 15:16 ${name}`).join('\n') + `\n${entries.length} files, 341023911 bytes uncompressed, 129445883 bytes compressed:  62.0%\n`;
    if (cmd === '/usr/bin/unzip' && args[0] === '-p' && args[2] === ROOT + '/Contents/Info.plist') return Buffer.from(plistText);
    if (cmd === '/usr/bin/unzip' && args[0] === '-p' && args[2] === ROOT + '/Contents/Resources/app-update.yml') { if (yml === null) throw new Error('caution: filename not matched'); return yml; }
    if (cmd === '/usr/bin/plutil') {
      assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-'], 'plutil converts to JSON, never to XML for a regex');
      plutilInputs.push({ file: args[4], text: fs.readFileSync(args[4], 'utf8') });
      return plutil(args[4]);
    }
    throw new Error('unexpected ' + cmd + ' ' + args.join(' '));
  };
  return { exec, calls, plutilInputs, structure: own, readStructure: file => { calls.push(['structure', file]); return own; } };
}

test('readMacBundle: the real tree is read by plutil (JSON), with its feed; the temp copy is removed', () => {
  const z = zipTool(realTree());
  assert.deepEqual(readMacBundle('/tmp/update.zip', { exec: z.exec, readStructure: z.readStructure }), bundle('0.2.9'));
  assert.deepEqual(z.calls.map(c => c.slice(0, 2)), [['structure', '/tmp/update.zip'], ['/usr/bin/unzip', '-Z1'], ['/usr/bin/unzip', '-Z'], ['/usr/bin/unzip', '-p'], ['/usr/bin/plutil', '-convert'], ['/usr/bin/unzip', '-p']]);
  assert.deepEqual(z.calls[3], ['/usr/bin/unzip', '-p', '/tmp/update.zip', 'SSAM Agent.app/Contents/Info.plist']);
  assert.equal(z.plutilInputs[0].text, infoPlist('0.2.9'), 'plutil reads the exact bytes of the entry');
  assert.equal(fs.existsSync(z.plutilInputs[0].file), false, 'the temp copy is removed');
  const noYml = zipTool(realTree().filter(e => !e[1].endsWith('app-update.yml')), { yml: null });
  assert.equal(readMacBundle('/tmp/u.zip', { exec: noYml.exec, readStructure: noYml.readStructure }).feed, null);
});

test('readMacBundle refuses the review probes: a second Old.APP, a nested x/SSAM Agent.app, a wrong-case or __MACOSX entry', () => {
  for (const [extra, pattern] of [
    [[['d', 'Old.APP/'], ['-', 'Old.APP/Contents/Info.plist']], /"Old\.APP\/" is outside SSAM Agent\.app\//],
    [[['d', 'x/'], ['d', 'x/SSAM Agent.app/'], ['-', 'x/SSAM Agent.app/Contents/Info.plist']], /"x\/" is outside/],
    [[['-', 'ssam agent.app/Contents/Info.plist']], /"ssam agent\.app\/Contents\/Info\.plist" is outside/],
    [[['d', '__MACOSX/'], ['-', '__MACOSX/SSAM Agent.app/Contents/._Info.plist']], /"__MACOSX\/" is outside/],
  ]) {
    const z = zipTool([...realTree(), ...extra]);
    const answer = readMacBundle('/tmp/u.zip', { exec: z.exec, readStructure: z.readStructure });
    assert.match(answer.error, pattern);
    assert.equal(z.calls.length, 3, 'nothing is extracted from a refused ZIP');
    assert.match(macBundleProblem({ bundle: answer, label: '0.2.9', current: '0.2.8' }).message, /UPDATE_INSTALLER_MISMATCH: the downloaded update has no readable SSAM Agent\.app Info\.plist/);
  }
});

test('readMacBundle: a plist with the version hidden in an XML comment reads what plutil (CoreFoundation) reads, so 0.2.7 stays 0.2.7', () => {
  const hidden = infoPlist('0.2.7').replace('<dict>', '<dict>\n  <!-- <key>CFBundleShortVersionString</key><string>0.2.9</string><key>CFBundleVersion</key><string>0.2.9</string> -->');
  const z = zipTool(realTree(), { plistText: hidden, plutil: () => plistJson('0.2.7') });
  const answer = readMacBundle('/tmp/u.zip', { exec: z.exec, readStructure: z.readStructure });
  assert.equal(z.plutilInputs[0].text, hidden, 'the whole plist, comment included, goes to plutil');
  assert.equal(answer.shortVersion, '0.2.7');
  assert.equal(macBundleProblem({ bundle: answer, label: '0.2.9', current: '0.2.8', feed: FEED }).code, UPDATE_CODES.INSTALLER_MISMATCH);
});

test('readMacBundle fails closed when plutil is missing, refuses the plist, prints no JSON dictionary or a value that is not a string', () => {
  const missing = Object.assign(new Error('spawnSync /usr/bin/plutil ENOENT'), { code: 'ENOENT' });
  for (const [plutil, pattern] of [
    [() => { throw missing; }, /ENOENT/],
    [() => { throw new Error('Command failed: /usr/bin/plutil -convert json\nInfo.plist: Property List error: Unexpected character'); }, /Command failed/],
    [() => 'not json', /JSON/],
    [() => '["an array"]', /not a dictionary/],
    [() => plistJson('0.2.9', { CFBundleVersion: 29 }), /CFBundleVersion is not a string/],
  ]) {
    const z = zipTool(realTree(), { plutil });
    const answer = readMacBundle('/tmp/u.zip', { exec: z.exec, readStructure: z.readStructure });
    assert.match(answer.error, pattern);
    assert.equal(macBundleProblem({ bundle: answer, label: '0.2.9', current: '0.2.8' }).code, UPDATE_CODES.INSTALLER_MISMATCH);
  }
  assert.match(readMacBundle('/tmp/u.zip', { exec: () => { throw new Error('unzip: cannot find zipfile'); }, readStructure: zipTool(realTree()).readStructure }).error, /cannot find zipfile/);
});

test('macZipProblem refuses duplicates, case and normalization duplicates, "..", absolute paths, backslashes and symlinks on the plist path', () => {
  const check = (entries, options = {}) => {
    const z = zipTool(entries, options);
    return macZipProblem({ names: zipNames(z.exec('/usr/bin/unzip', ['-Z1', 'u.zip'])), listing: zipListingRows(z.exec('/usr/bin/unzip', ['-Z', 'u.zip'])), structure: z.structure });
  };
  assert.equal(check(realTree()), null);
  const cases = [
    [[...realTree(), ['-', ROOT + '/Contents/Info.plist']], /twice/],
    [[...realTree(), ['d', ROOT + '/Contents']], /twice/],
    [[...realTree(), ['-', ROOT + '/Contents/info.plist']], /differ only in case/],
    [[...realTree(), ['-', ROOT + '/contents/Info.plist']], /differ only in case/],
    [[...realTree(), ['-', ROOT + '/Contents/Resources/café'], ['-', ROOT + '/Contents/Resources/café']], /normalization/],
    [[...realTree(), ['-', ROOT + '/../Info.plist']], /"\.\." part/],
    [[...realTree(), ['-', ROOT + '/Contents/./Info.plist']], /"\.\." part|"\." /],
    [[...realTree(), ['-', ROOT + '//Contents/Info.plist']], /empty/],
    [[...realTree(), ['-', '/' + ROOT + '/Contents/Info.plist']], /not a plain relative path/],
    [[...realTree(), ['-', ROOT + '/Contents\\..\\..\\Info.plist']], /not a plain relative path/],
    [realTree().map(e => e[1] === ROOT + '/Contents/' ? ['l', ROOT + '/Contents'] : e), /"SSAM Agent\.app\/Contents" is a symlink/],
    [realTree().map(e => e[1] === ROOT + '/Contents/Info.plist' ? ['l', e[1]] : e), /Info\.plist" is a symlink/],
    [realTree().map(e => e[1] === ROOT + '/Contents/Resources/' ? ['l', ROOT + '/Contents/Resources'] : e), /Resources" is a symlink/],
    [realTree().map(e => e[1] === ROOT + '/Contents/Resources/app-update.yml' ? ['l', e[1]] : e), /app-update\.yml" is a symlink/],
    [realTree().map(e => e[1] === ROOT + '/' ? ['l', ROOT] : e), /"SSAM Agent\.app" is outside SSAM Agent\.app\//],
    [realTree().filter(e => !e[1].endsWith('/Contents/Info.plist')), /no regular file SSAM Agent\.app\/Contents\/Info\.plist/],
    [realTree().map(e => e[1] === ROOT + '/Contents/Info.plist' ? ['d', e[1] + '/'] : e), /no regular file/],
  ];
  for (const [entries, pattern] of cases) assert.match(String(check(entries)), pattern, JSON.stringify(entries.at(-1)));
  // The two listings and the header must name the same entries: a name hidden in a row (a newline in a name) does not add up.
  assert.match(check(realTree(), { header: realTree().length + 1 }), /does not add up/);
  assert.match(check(realTree(), { names: realTree().map(e => e[1]).reverse() }), /disagree/);
  assert.match(check(realTree(), { names: [...realTree().map(e => e[1]), 'SSAM Agent.app/x'] }), /does not add up/);
  assert.match(macZipProblem({ names: [], listing: zipListingRows('') }), /no entries/);
  // Review M-R3-1: the file's own headers (zip-structure.mjs) must hold the same entries, with the same types, or nothing passes.
  const z = zipTool(realTree());
  const listed = { names: zipNames(z.exec('/usr/bin/unzip', ['-Z1', 'u.zip'])), listing: zipListingRows(z.exec('/usr/bin/unzip', ['-Z', 'u.zip'])) };
  assert.match(macZipProblem(listed), /structure is not sound: not read/);
  assert.match(macZipProblem({ ...listed, structure: { problem: 'the ZIP has 91 bytes between its last listed entry and the central directory that no listed entry covers' } }), /structure is not sound: the ZIP has 91 bytes/);
  assert.match(macZipProblem({ ...listed, structure: { entries: z.structure.entries.slice(1) } }), /own headers hold 12 entries, unzip lists 13/);
  assert.match(macZipProblem({ ...listed, structure: { entries: z.structure.entries.map((e, i) => i === 4 ? { ...e, name: 'Old.app/x' } : e) } }), /own headers and unzip disagree at entry 5/);
  assert.match(macZipProblem({ ...listed, structure: { entries: z.structure.entries.map((e, i) => i === 4 ? { ...e, type: 'l', link: 'A' } : e) } }), /own headers and unzip disagree at entry 5/);
  // The symlinks of the frameworks stay allowed: they are not on the way to the plist or the feed.
  assert.equal(realTree().filter(e => e[0] === 'l').length, 2);
});

test('the update must name this app\'s own feed (review M4-R2): staging into production, or no feed, is refused', () => {
  assert.equal(appUpdateFeed(`url: ${FEED}/\n`), FEED);
  assert.equal(appUpdateFeed(`provider: generic\nurl: '${FEED}'\n`), FEED);
  assert.equal(appUpdateFeed('provider: generic\n'), null);
  assert.equal(macBundleProblem({ bundle: bundle('0.2.9'), label: '0.2.9', current: '0.2.8', feed: FEED + '/' }), null);
  const staging = macBundleProblem({ bundle: bundle('0.2.9', { feed: 'https://dist.ssam.pro/u/ssam-agent-staging' }), label: '0.2.9', current: '0.2.8', feed: 'https://dist.ssam.pro/u/ssam-agent' });
  assert.equal(staging.code, UPDATE_CODES.INSTALLER_MISMATCH);
  assert.match(staging.message, /updates from https:\/\/dist\.ssam\.pro\/u\/ssam-agent-staging, not from this app's feed https:\/\/dist\.ssam\.pro\/u\/ssam-agent;/);
  assert.match(macBundleProblem({ bundle: bundle('0.2.9', { feed: null }), label: '0.2.9', current: '0.2.8', feed: FEED }).message, /updates from no feed/);
});

test('checkMacUpdate measures the ZIP again after the gate: bytes that changed during it are refused', async () => {
  const sha512 = 'B'.repeat(86) + '==';
  const info = { version: '0.2.9', downloadedFile: '/tmp/u.zip', files: [{ url: 'u.zip', sha512, size: 10 }] };
  let calls = 0;
  const measure = async () => (++calls === 1 ? { sha512, size: 10 } : { sha512: 'C'.repeat(86) + '==', size: 10 });
  const changed = await checkMacUpdate({ info, currentVersion: '0.2.8', feed: FEED, readBundle: () => bundle('0.2.9'), measure });
  assert.equal(calls, 2);
  assert.equal(changed.problem.code, UPDATE_CODES.STATEMENT_MISMATCH);
  assert.match(changed.problem.message, /changed while it was checked/);
  const same = await checkMacUpdate({ info, currentVersion: '0.2.8', feed: FEED, readBundle: () => bundle('0.2.9'), measure: async () => ({ sha512, size: 10 }) });
  assert.deepEqual(same.approved, { file: '/tmp/u.zip', sha512, size: 10, bundleVersion: '0.2.9' });
  const wrongFeed = await checkMacUpdate({ info, currentVersion: '0.2.8', feed: 'https://dist.ssam.pro/u/ssam-agent', readBundle: () => bundle('0.2.9'), measure: async () => ({ sha512, size: 10 }) });
  assert.equal(wrongFeed.problem.code, UPDATE_CODES.INSTALLER_MISMATCH);
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
  assert.match(silent.entries.find(e => e.event === 'update-handoff-timeout')?.note, /may still stage this checked ZIP/, 'B-R2-2: the timeout says Squirrel may still stage it');
});

test('Mac flow: an update built for another feed (staging into production) never reaches Squirrel.Mac', async t => {
  const f = macFixture(t, { readBundle: () => bundle('0.2.9', { feed: 'https://dist.example/u-staging' }) });
  f.fake.downloaded(f.info); await wait(30);
  assert.equal(f.native.checks, 0);
  assert.equal(f.updates.state.status, 'error');
  assert.match(f.entries.find(e => e.event === 'update-refused')?.reason, /updates from https:\/\/dist\.example\/u-staging, not from this app's feed https:\/\/dist\.example\/u;/);
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

// Review B-R3-1: an entry below a symlink would be written wherever the symlink points (ditto follows it), and a symlink may only
// point inside its own bundle: no absolute target, no "..". The real ZIP (14 symlinks, all like Versions/Current/Resources or A)
// passes; see zip-structure.test.mjs for the real build A ZIP read end to end.
test('macZipProblem refuses an entry below a symlink and a symlink that points out of the bundle', () => {
  const check = (entries, options = {}) => {
    const z = zipTool(entries, options);
    return macZipProblem({ names: zipNames(z.exec('/usr/bin/unzip', ['-Z1', 'u.zip'])), listing: zipListingRows(z.exec('/usr/bin/unzip', ['-Z', 'u.zip'])), structure: z.structure });
  };
  const link = ROOT + '/Contents/Frameworks/x';
  assert.equal(check([...realTree(), ['l', link]], { links: { [link]: 'Electron Framework.framework/Versions/A' } }), null);
  assert.match(check([...realTree(), ['l', link], ['-', link + '/evil.plist']], { links: { [link]: 'Electron Framework.framework' } }), /"SSAM Agent\.app\/Contents\/Frameworks\/x\/evil\.plist" is below the symlink "SSAM Agent\.app\/Contents\/Frameworks\/x"/);
  assert.match(check([...realTree(), ['l', link], ['d', link + '/deeper/'], ['-', link + '/deeper/evil.plist']], { links: { [link]: 'A' } }), /is below the symlink/);
  for (const [target, pattern] of [['/Users/me/Library/LaunchAgents', /absolute/], ['../../../../Library/LaunchAgents', /out of its folder \("\.\."\)/], ['A/../../B', /"\.\."/],
    ['', /no readable target/], [null, /no readable target/], ['a\\b', /unusual/], ['x'.repeat(1025), /unusual/]])
    assert.match(String(check([...realTree(), ['l', link]], { links: { [link]: target } })), pattern, String(target).slice(0, 40));
  assert.equal(check(realTree()), null, 'the framework symlinks of the real ZIP stay allowed');
});

// Review B-R4-3: the Mac volume ignores case (and normalization), so `Frameworks/X/evil.plist` lands below the symlink
// `Frameworks/x`, and a symlink `contents` is the folder `Contents` even when no `Contents/` entry is listed. The review's
// probes (C:\t\r5\mac-028\review\r4-probes\src\case-symlink.mjs) as they are, then over the real tree.
test('macZipProblem compares symlink paths without case or normalization (review B-R4-3)', () => {
  const direct = list => macZipProblem({
    names: list.map(e => e[0]),
    listing: { entries: list.length, rows: list.map(([name, type]) => ({ name, mode: type === 'd' ? 'drwxr-xr-x' : type === 'l' ? 'lrwxr-xr-x' : '-rw-r--r--' })) },
    structure: { entries: list.map(([name, type, link]) => ({ name, type, link: link ?? null })) },
  });
  const base = [[ROOT + '/', 'd'], [ROOT + '/Contents/', 'd'], [ROOT + '/Contents/Info.plist', '-']];
  assert.match(direct([...base, [ROOT + '/Contents/Frameworks/x', 'l', 'y'], [ROOT + '/Contents/Frameworks/x/evil.plist', '-']]), /is below the symlink "SSAM Agent\.app\/Contents\/Frameworks\/x"/);
  assert.match(direct([...base, [ROOT + '/Contents/Frameworks/x', 'l', 'y'], [ROOT + '/Contents/Frameworks/X/evil.plist', '-']]),
    /"SSAM Agent\.app\/Contents\/Frameworks\/X\/evil\.plist" is below the symlink "SSAM Agent\.app\/Contents\/Frameworks\/x" \(case and normalization ignored\)/);
  assert.match(direct([[ROOT + '/', 'd'], [ROOT + '/contents', 'l', 'Real'], [ROOT + '/Contents/Info.plist', '-'], [ROOT + '/Real/Info.plist', '-']]),
    /"SSAM Agent\.app\/contents" is a symlink where the gate reads SSAM Agent\.app\/Contents/);
  const check = (entries, options = {}) => {
    const z = zipTool(entries, options);
    return macZipProblem({ names: zipNames(z.exec('/usr/bin/unzip', ['-Z1', 'u.zip'])), listing: zipListingRows(z.exec('/usr/bin/unzip', ['-Z', 'u.zip'])), structure: z.structure });
  };
  const link = ROOT + '/Contents/Frameworks/x';
  assert.match(check([...realTree(), ['l', link], ['-', ROOT + '/Contents/Frameworks/X/evil.plist']], { links: { [link]: 'A' } }), /is below the symlink "SSAM Agent\.app\/Contents\/Frameworks\/x"/);
  assert.match(check([...realTree(), ['l', link], ['-', ROOT + '/Contents/FRAMEWORKS/X/deeper/evil.plist']], { links: { [link]: 'A' } }), /below the symlink "SSAM Agent\.app\/Contents\/Frameworks\/x"/);
  // A folder entry in the other case is the symlink itself, listed twice.
  assert.match(check([...realTree(), ['l', link], ['d', ROOT + '/Contents/FRAMEWORKS/X/']], { links: { [link]: 'A' } }), /differ only in case/);
  // The gated paths in another case: a symlink `resources` or `info.plist` next to the real ones is a case duplicate; without
  // the real folder entry it is the gated path itself.
  const noResources = realTree().filter(e => !e[1].startsWith(ROOT + '/Contents/Resources/'));
  assert.match(check([...noResources, ['l', ROOT + '/Contents/resources'], ['-', ROOT + '/Contents/Resources/app-update.yml']], { links: { [ROOT + '/Contents/resources']: 'MacOS' } }),
    /"SSAM Agent\.app\/Contents\/resources" is a symlink where the gate reads SSAM Agent\.app\/Contents\/Resources/);
  assert.match(check([...realTree(), ['l', ROOT + '/Contents/info.plist']], { links: { [ROOT + '/Contents/info.plist']: 'MacOS/SSAM Agent' } }), /differ only in case/);
  // A symlink target outside printable ASCII.
  assert.match(String(check([...realTree(), ['l', link]], { links: { [link]: 'Electron Framework.framework/Versions/\u00c5' } })), /unusual/);
  assert.equal(check(realTree()), null, 'the real tree stays allowed');
});

// Review B-R3-2: plutil -convert json fails on <data> and <date>; electron-builder writes extendInfo into Info.plist, so a value
// of those kinds there would make every Mac refuse every update (closed, but silent). The plist values must stay JSON-able.
test('the Info.plist values the build adds (electron-builder.yml mac.extendInfo) can all be read by plutil -convert json', async () => {
  const { default: yaml } = await import('js-yaml');
  const config = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'electron-builder.yml'), 'utf8'));
  const plain = value => ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.every(plain)) || (value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plain));
  assert.ok(config.mac.extendInfo && Object.keys(config.mac.extendInfo).length > 0);
  for (const [key, value] of Object.entries(config.mac.extendInfo)) assert.ok(plain(value), `extendInfo ${key} is not a string, number, boolean, array or dict: plutil -convert json would refuse the plist`);
  const build = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'build.mjs'), 'utf8');
  assert.doesNotMatch(build, /extendInfo/, 'build.mjs adds no Info.plist values of its own');
});

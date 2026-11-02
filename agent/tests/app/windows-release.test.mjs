// The Windows release of the app (0.2.0): the signing identity the owner gives (thumbprint and publisher CN, never the
// certificate), the electron-builder configuration it becomes, the updater configuration a signed build must carry
// (app-update.yml: the dist.ssam.pro feed and the publisher every update is checked against), the rule that a Windows build
// which cannot verify an update never installs one, and the unsigned test app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signingOf, signingConfig, testUnsignedConfig, updaterConfigProblems, DEFAULT_TIMESTAMP_URL } from '../../scripts/windows-release.mjs';
import { checkWindowsOutput, withoutOffers, DEFAULT_UPDATE_URL } from '../../scripts/build.mjs';
import { publisherNames, updateTrustProblem, reduce, INITIAL, updateText } from '../../src/main/core/update-model.mjs';

const app = path.resolve(import.meta.dirname, '../..');
const THUMB = 'AB'.repeat(20);
// What electron-builder 26 writes to resources/app-update.yml for a signed build with signtoolOptions.publisherName.
const SIGNED_YML = 'provider: generic\nurl: https://dist.ssam.pro/u/ssam-agent\nchannel: latest\nupdaterCacheDirName: ssam-agent-app-updater\npublisherName:\n  - Andre Machado\n';
const UNSIGNED_YML = 'provider: generic\nurl: https://dist.ssam.pro/u/ssam-agent\nchannel: latest\nupdaterCacheDirName: ssam-agent-app-updater\n';

test('the signing identity: a 40-hex thumbprint and the subject CN, from options or the environment, nothing secret', () => {
  assert.deepEqual(signingOf({ certSha1: THUMB.toLowerCase(), publisherName: 'Andre Machado' }, {}),
    { ok: true, certSha1: THUMB, publisherName: 'Andre Machado', timestampUrl: DEFAULT_TIMESTAMP_URL });
  assert.equal(signingOf({}, { SSAM_WIN_CERT_SHA1: THUMB, SSAM_WIN_PUBLISHER_NAME: 'SSAM' }).publisherName, 'SSAM');
  const missing = signingOf({}, {});
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /--cert-sha1/); assert.match(missing.problem, /--publisher-name/); assert.match(missing.problem, /--test-unsigned/);
  assert.equal(signingOf({ certSha1: 'xyz', publisherName: 'A' }, {}).ok, false);
  assert.equal(signingOf({ certSha1: THUMB, publisherName: 'A, B' }, {}).ok, false, 'one publisher only');
});

test('electron-builder: signtool by thumbprint, the publisher written for the updater, signing forced; the test app has no publish', () => {
  const config = signingConfig(signingOf({ certSha1: THUMB, publisherName: 'Andre Machado' }, {}));
  assert.equal(config.forceCodeSigning, true);
  assert.deepEqual(config.win.signtoolOptions, { certificateSha1: THUMB, publisherName: ['Andre Machado'], rfc3161TimeStampServer: DEFAULT_TIMESTAMP_URL, signingHashAlgorithms: ['sha256'] });
  const test = testUnsignedConfig();
  assert.equal(test.publish, null);
  assert.match(test.nsis.artifactName, /test-unsigned/);
});

test('app-update.yml of a release: generic provider, the dist.ssam.pro feed, channel latest, the publisher required', () => {
  const want = { url: DEFAULT_UPDATE_URL, publisherName: 'Andre Machado' };
  assert.equal(DEFAULT_UPDATE_URL, 'https://dist.ssam.pro/u/ssam-agent');
  assert.deepEqual(updaterConfigProblems(SIGNED_YML, want), []);
  assert.deepEqual(updaterConfigProblems(SIGNED_YML.replace(/\n/g, '\r\n'), want), []);
  assert.match(updaterConfigProblems(UNSIGNED_YML, want).join(), /updates would not be verified/);
  assert.match(updaterConfigProblems(SIGNED_YML.replace('dist.ssam.pro', 'evil.example'), want).join(), /url is https:\/\/evil\.example/);
  assert.match(updaterConfigProblems(null, want).join(), /never update itself/);
  assert.deepEqual(publisherNames(SIGNED_YML), ['Andre Machado']);
  assert.deepEqual(publisherNames("publisherName: ['A B', C]\n"), ['A B', 'C']);
  assert.deepEqual(publisherNames(UNSIGNED_YML), []);
});

test('a packaged Windows app installs only updates it can verify; otherwise updates are off and the panel says why', () => {
  assert.equal(updateTrustProblem({ platform: 'win32', isPackaged: true, appUpdateYml: SIGNED_YML }), null);
  assert.match(updateTrustProblem({ platform: 'win32', isPackaged: true, appUpdateYml: UNSIGNED_YML }), /cannot verify the signature/);
  assert.match(updateTrustProblem({ platform: 'win32', isPackaged: true, appUpdateYml: null }), /cannot verify the signature/, 'a server set by hand on a build without app-update.yml');
  assert.equal(updateTrustProblem({ platform: 'darwin', isPackaged: true, appUpdateYml: null }), null);
  assert.equal(updateTrustProblem({ platform: 'win32', isPackaged: false, appUpdateYml: null }), null);
  const off = reduce(INITIAL, { type: 'off', reason: updateTrustProblem({ platform: 'win32', isPackaged: true, appUpdateYml: UNSIGNED_YML }) });
  assert.equal(off.status, 'off');
  assert.match(updateText(off, '0.2.0'), /^Version 0\.2\.0\. Updates are off: this build cannot verify/);
  assert.match(updateText(reduce(INITIAL, { type: 'off' }), '0.2.0'), /no update server is configured/);
});

test('after electron-builder: a release whose app-update.yml lacks the publisher, or whose installer is not signed, stops', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-win-out-'));
  try {
    const resources = path.join(dist, 'win-unpacked', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(dist, 'latest.yml'), 'version: 0.2.0\n');
    fs.writeFileSync(path.join(dist, 'ssam-agent-app-0.2.0-setup.exe'), 'x');
    const options = { updateUrl: DEFAULT_UPDATE_URL, signing: { certSha1: THUMB, publisherName: 'Andre Machado' } };
    fs.writeFileSync(path.join(resources, 'app-update.yml'), SIGNED_YML);
    assert.doesNotThrow(() => checkWindowsOutput(dist, options, { thumbprint: () => THUMB }));
    assert.throws(() => checkWindowsOutput(dist, options, { thumbprint: () => null }), /setup\.exe is not signed by certificate/);
    fs.writeFileSync(path.join(resources, 'app-update.yml'), UNSIGNED_YML);
    assert.throws(() => checkWindowsOutput(dist, options, { thumbprint: () => THUMB }), /updates would not be verified/);
    // the test app: no updater configuration at all
    assert.throws(() => checkWindowsOutput(dist, { testUnsigned: true, noUpdates: true }), /must not carry resources\/app-update.yml/);
    fs.rmSync(path.join(resources, 'app-update.yml'));
    assert.doesNotThrow(() => checkWindowsOutput(dist, { testUnsigned: true, noUpdates: true }));
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('the test app pack says bridgeOffer false, the rest of pack.json unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-test-pack-'));
  try {
    fs.writeFileSync(path.join(dir, 'pack.json'), '﻿' + JSON.stringify({ id: 'p', files: [{ path: 'a', sha256: 'b' }] }));
    assert.deepEqual(withoutOffers(dir), { id: 'p', files: [{ path: 'a', sha256: 'b' }], bridgeOffer: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build.mjs: a Windows release without the signing identity refuses before any pack; the test app takes no certificate', () => {
  const run = args => spawnSync(process.execPath, [path.join(app, 'scripts/build.mjs'), '--platform', 'win', '--native', 'x.exe', ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SSAM_WIN_CERT_SHA1: '', SSAM_WIN_PUBLISHER_NAME: '' } });
  const unsigned = run([]);
  assert.equal(unsigned.status, 1); assert.match(unsigned.stderr, /A signed Windows release needs --cert-sha1/);
  const mixed = run(['--test-unsigned', '--cert-sha1', THUMB]);
  assert.equal(mixed.status, 1); assert.match(mixed.stderr, /--test-unsigned takes no signing certificate/);
  const mac = spawnSync(process.execPath, [path.join(app, 'scripts/build.mjs'), '--platform', 'mac', '--test-unsigned'], { encoding: 'utf8', windowsHide: true });
  assert.equal(mac.status, 1); assert.match(mac.stderr, /Windows test app only/);
});

test('the app version is 0.2.0, the first that updates itself from dist.ssam.pro', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.0');
  const yml = fs.readFileSync(path.join(app, 'electron-builder.yml'), 'utf8').split('\r\n').join('\n');
  assert.match(yml, /^publish:\n  provider: generic\n  url: https:\/\/dist\.ssam\.pro\/u\/ssam-agent\n  channel: latest$/m);
  assert.doesNotMatch(yml, /verifyUpdateCodeSignature:\s*false/);
});

test('the pack executables are signed before their hashes are final, and electron-builder never re-signs them', async () => {
  const { signPackExecutables, packExecutables } = await import('../../scripts/windows-release.mjs');
  const { createHash } = await import('node:crypto');
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sign-pack-'));
  try {
    const exe = path.join(dir, 'bin', 'o11', 'connect', 'Anvil.Connect.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'unsigned');
    fs.writeFileSync(path.join(dir, 'a.dll'), 'dll');
    const pack = { id: 'p', files: [{ path: 'bin/o11/connect/Anvil.Connect.exe', size: 8, sha256: sha256('unsigned') }, { path: 'a.dll', size: 3, sha256: sha256('dll') }] };
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
    const signedFiles = new Set(), calls = [];
    // signtool appends a signature; Get-AuthenticodeSignature answers the thumbprint of a signed file only.
    const run = (tool, args, opts) => {
      calls.push(tool);
      if (tool === 'powershell') return { status: 0, stdout: signedFiles.has(opts.env.SSAM_SIGNED_FILE) ? THUMB : '' };
      const target = args.at(-1); fs.appendFileSync(target, '+signature'); signedFiles.add(target); return { status: 0 };
    };
    assert.deepEqual(signPackExecutables(dir, { certSha1: THUMB, timestampUrl: DEFAULT_TIMESTAMP_URL }, { run, signtool: 'signtool.exe', sha256 }), ['bin/o11/connect/Anvil.Connect.exe']);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(written.files[0].sha256, sha256('unsigned+signature'));
    assert.equal(written.files[0].size, 'unsigned+signature'.length);
    assert.equal(written.files[1].sha256, sha256('dll'));
    assert.ok(calls.includes('signtool.exe'));
    // already signed by the release certificate: not signed twice
    calls.length = 0;
    signPackExecutables(dir, { certSha1: THUMB, timestampUrl: DEFAULT_TIMESTAMP_URL }, { run, signtool: 'signtool.exe', sha256 });
    assert.equal(calls.includes('signtool.exe'), false);
    // electron-builder: the pack executables by name in signExts "!<name>" (the app exe and installer are still signed)
    const config = signingConfig({ certSha1: THUMB, publisherName: 'A', timestampUrl: DEFAULT_TIMESTAMP_URL },
      packExecutables({ files: [...pack.files, { path: 'native/ssam-agent.exe' }, { path: 'odc/studio/bridge/client/bin/Release/net10.0/ODC3.Bridge.Client.exe' }] }));
    assert.deepEqual(config.win.signExts, ['!Anvil.Connect.exe', '!ssam-agent.exe', '!ODC3.Bridge.Client.exe']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

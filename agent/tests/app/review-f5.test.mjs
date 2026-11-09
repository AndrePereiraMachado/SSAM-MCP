// The findings of the F5 review (C:\t\r4\REVISAO-F5-APP.md), each as a test that fails before its fix:
//   A1  a signed pack executable keeps every pin naming it (xifEngine, o11Bridge, o11Builds) on its new bytes;
//   M3  the post-build gate runs verifyPack on resources/pack and checks every pin against the file;
//   M1  publisherName is checked against the real signer subject with electron-updater's own rule, full DN allowed;
//   M2  a signed app keeps its build's feed, and installs only an installer whose own version is the announced one and newer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { signPackExecutables, signingOf, publisherMatches, updaterConfigProblems, DEFAULT_TIMESTAMP_URL } from '../../scripts/windows-release.mjs';
import { recomputePins, packProblems } from '../../scripts/pack-pins.mjs';
import { stageNativePack } from '../../scripts/native-pack.mjs';
import { checkWindowsOutput, DEFAULT_UPDATE_URL } from '../../scripts/build.mjs';
import { publisherNames, installerVersionProblem } from '../../src/main/core/update-model.mjs';
import { resolveUpdateUrl } from '../../src/main/core/settings.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const THUMB = 'CD'.repeat(20);
const DN = 'CN=Andre Machado, O=SSAM Tecnologia Ltda, L=Sao Paulo, C=BR';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// A pack folder from {path: text}, with pack.json listing every file and the given extra fields.
function packDir(dir, entries, extra = {}) {
  const files = [];
  for (const [rel, text] of Object.entries(entries)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text);
    files.push({ path: rel, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) });
  }
  const pack = { id: 'p', lanes: [], files, ...extra(files) };
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
  return pack;
}
const fileSha = (files, rel) => files.find(f => f.path === rel).sha256;

test('A1: signing the engine host keeps xifEngine.sha256 (and every pin) on the signed bytes', () => {
  const dir = tmp('ssam-a1-');
  try {
    packDir(dir, { 'xif-engine/Anvil.Xif.Engine.exe': 'engine', 'bin/o11/bridge/Anvil.Bridge.dll': 'bridge' }, files => ({
      xifEngine: { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: fileSha(files, 'xif-engine/Anvil.Xif.Engine.exe') },
      o11Bridge: { path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: fileSha(files, 'bin/o11/bridge/Anvil.Bridge.dll') },
      o11Builds: [{ version: '11.55.94', path: 'bin/o11/bridge/Anvil.Bridge.dll', sha256: fileSha(files, 'bin/o11/bridge/Anvil.Bridge.dll') }] }));
    const signedFiles = new Set();
    const run = (tool, args, opts) => {
      if (tool === 'powershell') return { status: 0, stdout: signedFiles.has(opts.env.SSAM_SIGNED_FILE) ? THUMB : '' };
      fs.appendFileSync(args.at(-1), '+signature'); signedFiles.add(args.at(-1)); return { status: 0 };
    };
    signPackExecutables(dir, { certSha1: THUMB, timestampUrl: DEFAULT_TIMESTAMP_URL }, { run, signtool: 'signtool.exe', sha256: sha });
    const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(pack.xifEngine.sha256, sha('engine+signature'));
    assert.equal(pack.xifEngine.sha256, fileSha(pack.files, 'xif-engine/Anvil.Xif.Engine.exe'));
    assert.deepEqual(packProblems(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A1: the central recompute fills every pin from files[] and refuses a pin naming an unlisted file', () => {
  const pack = { files: [{ path: 'x/a.exe', sha256: 'a'.repeat(64) }, { path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: 'b'.repeat(64) }],
    xifEngine: { path: 'x/a.exe', sha256: 'old' }, o11Builds: [{ version: '11.55.93', path: 'bin/o11/bridges/11.55.93/Anvil.Bridge.dll', sha256: 'old' }] };
  const next = recomputePins(pack);
  assert.equal(next.xifEngine.sha256, 'a'.repeat(64)); assert.equal(next.o11Builds[0].sha256, 'b'.repeat(64));
  assert.throws(() => recomputePins({ files: [], xifEngine: { path: 'x/a.exe', sha256: 'z' } }), /files list does not have/);
});

test('A1: staging the native core recomputes the pins of the staged pack', () => {
  const work = tmp('ssam-a1n-');
  try {
    const source = path.join(work, 'source');
    packDir(source, { 'xif-engine/Anvil.Xif.Engine.exe': 'engine-signed' }, () => ({ xifEngine: { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: sha('engine-unsigned') } }));
    const pe = 64, native = Buffer.alloc(pe + 264);
    native.writeUInt32LE(pe, 0x3c); native.writeUInt32LE(0x4550, pe); native.writeUInt16LE(0x8664, pe + 4); native.writeUInt16LE(0x20b, pe + 24);
    fs.writeFileSync(path.join(work, 'ssam-agent.exe'), native);
    const staged = stageNativePack(source, path.join(work, 'ssam-agent.exe'), path.join(work, 'staged'));
    assert.equal(staged.xifEngine.sha256, sha('engine-signed'));
    assert.deepEqual(packProblems(path.join(work, 'staged')), []);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

// A dist folder with win-unpacked/resources/pack and, for a release, app-update.yml, latest.yml and an installer.
function dist(release, { pin } = {}) {
  const root = tmp('ssam-gate-');
  const resources = path.join(root, 'win-unpacked', 'resources');
  packDir(path.join(resources, 'pack'), { 'xif-engine/Anvil.Xif.Engine.exe': 'engine' }, files => ({ xifEngine: { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: pin ?? fileSha(files, 'xif-engine/Anvil.Xif.Engine.exe') } }));
  if (release) {
    fs.writeFileSync(path.join(resources, 'app-update.yml'), `provider: generic\nurl: ${DEFAULT_UPDATE_URL}\nchannel: latest\npublisherName:\n  - '${DN}'\n`);
    fs.writeFileSync(path.join(root, 'latest.yml'), 'version: 0.2.0\n');
    fs.writeFileSync(path.join(root, 'ssam-agent-app-0.2.0-setup.exe'), 'x');
  }
  return root;
}

test('M3: the gate refuses a build whose installed pack has a stale pin or is not whole, signed or not', () => {
  const ok = dist(false), stale = dist(false, { pin: 'f'.repeat(64) }), broken = dist(false);
  try {
    assert.doesNotThrow(() => checkWindowsOutput(ok, { testUnsigned: true, noUpdates: true }));
    assert.throws(() => checkWindowsOutput(stale, { testUnsigned: true, noUpdates: true }), /resources\/pack: xifEngine pins xif-engine\/Anvil\.Xif\.Engine\.exe/);
    fs.appendFileSync(path.join(broken, 'win-unpacked', 'resources', 'pack', 'xif-engine', 'Anvil.Xif.Engine.exe'), 'changed');
    assert.throws(() => checkWindowsOutput(broken, { testUnsigned: true, noUpdates: true }), /resources\/pack: the pack is not whole/);
  } finally { for (const d of [ok, stale, broken]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('M1: publisherName is judged against the real signer as electron-updater will, and a full DN is allowed', () => {
  assert.equal(signingOf({ certSha1: THUMB, publisherName: DN }, {}).ok, true, 'a DN with commas is accepted');
  assert.equal(publisherMatches(DN, DN), true);
  assert.equal(publisherMatches('Andre Machado', DN), true, 'CN only');
  assert.equal(publisherMatches('Andre machado', DN), false, 'case matters');
  assert.equal(publisherMatches('CN=Andre Machado, O=SSAM Tecnologia, C=BR', DN), false, 'every DN key must match');
  assert.deepEqual(publisherNames(`publisherName:\n  - '${DN}'\n`), [DN]);
  assert.deepEqual(publisherNames(`publisherName:\n  - ${DN}\n`), [DN]);
  assert.deepEqual(publisherNames(`publisherName: ['${DN}', Other]\n`), [DN, 'Other']);
  assert.deepEqual(publisherNames(`publisherName: ${DN}\n`), [DN]);
  assert.deepEqual(updaterConfigProblems(`provider: generic\nurl: ${DEFAULT_UPDATE_URL}\nchannel: latest\npublisherName:\n  - '${DN}'\n`, { url: DEFAULT_UPDATE_URL, publisherName: DN }), []);
  const root = dist(true);
  try {
    const options = { updateUrl: DEFAULT_UPDATE_URL, signing: { certSha1: THUMB, publisherName: DN } };
    assert.doesNotThrow(() => checkWindowsOutput(root, options, { thumbprint: () => THUMB, subject: () => DN }));
    assert.throws(() => checkWindowsOutput(root, options, { thumbprint: () => THUMB, subject: () => 'CN=Andre Machado, O=Other, C=BR' }), /the updater would refuse every update/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('M2: an installer is installed only when its own version is the announced one and newer than the app', () => {
  assert.equal(installerVersionProblem({ productVersion: '0.2.1', productName: 'SSAM Agent', label: '0.2.1', current: '0.2.0' }), null);
  assert.match(installerVersionProblem({ productVersion: '0.2.0', productName: 'SSAM Agent', label: '9.9.9', current: '0.2.0' }), /announced 9\.9\.9/);
  assert.match(installerVersionProblem({ productVersion: '0.1.9', productName: 'SSAM Agent', label: '0.1.9', current: '0.2.0' }), /not newer than this app/);
  assert.match(installerVersionProblem({ productVersion: null, label: '0.2.1', current: '0.2.0' }), /no readable version/);
  assert.match(installerVersionProblem({ productVersion: '0.2.1', productName: 'Other', label: '0.2.1', current: '0.2.0' }), /not SSAM Agent/);
});

test('M2: a signed app keeps the feed of its build; the environment and the setting cannot move it', () => {
  const build = 'https://dist.ssam.pro/u/ssam-agent';
  assert.deepEqual(resolveUpdateUrl({ env: { SSAM_UPDATE_URL: 'https://evil.example/x' }, settings: { updateUrl: 'https://evil.example/y' }, build, pinned: true }), { url: build, source: 'build', pinned: true });
  assert.deepEqual(resolveUpdateUrl({ env: { SSAM_UPDATE_URL: 'https://e/x' }, settings: {}, build, pinned: false }), { url: 'https://e/x', source: 'env' });
  assert.deepEqual(resolveUpdateUrl({ env: {}, settings: {}, build: null, pinned: true }), { url: null, source: null, pinned: true });
});

test('M2: the updater never installs on quit before the downloaded installer was checked', () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/main/electron/updates.mjs'), 'utf8');
  assert.match(text, /autoUpdater\.autoInstallOnAppQuit = false;/);
  assert.doesNotMatch(text, /autoUpdater\.autoInstallOnAppQuit = true;\s*\n\s*autoUpdater\.allowPrerelease/);
  // App 0.2.8: the check moved to core/update-verify.mjs (after the signed statement), called before an update is ready.
  const verify = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/main/core/update-verify.mjs'), 'utf8');
  assert.match(verify, /^  const problem = installerVersionProblem\(\{ \.\.\.readInstaller\(info\?\.downloadedFile\)/m);
  // Review M1/M2 of 0.2.8: the order, the re-hash and the install on quit are tested by behaviour in updates-flow.test.mjs.
  assert.match(text, /answer = await verifyUpdate\(/);
  assert.match(text, /if \(state\.status !== 'ready' \|\| !verified\) return false;/);
  // Review M1 of agent/mac-028: every platform verifies a download before anything installs it (macOS too).
  assert.match(text, /autoUpdater\.on\('update-downloaded', info => \{ autoUpdater\.autoInstallOnAppQuit = false; verifyDownload\(info\); \}\);/);
  assert.doesNotMatch(text, /autoInstallOnAppQuit = true/);
});

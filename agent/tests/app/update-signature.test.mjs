// App 0.2.8: the Windows app is never Authenticode-signed; it installs an update only with the owner's Ed25519-signed
// statement (src/main/core/update-signature.mjs, update-verify.mjs), and the publisher signs it with the vigia vault's
// manifest key (scripts/sign-windows-update.mjs through sign-windows-update.ps1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { statementFor, signStatement, readStatement, updateStatementProblem, statementUrl, installerName, UPDATE_CODES, UPDATE_STATEMENT_DOMAIN } from '../../src/main/core/update-signature.mjs';
import { verifyWindowsUpdate, fetchStatementText } from '../../src/main/core/update-verify.mjs';
import { updateTrustProblem } from '../../src/main/core/update-model.mjs';
import { UPDATE_PUBLIC_KEY } from '../../src/main/core/update-trust.mjs';
import { signDist, parseArgs } from '../../scripts/sign-windows-update.mjs';
import { mainBundleKeyProblem, updateSpkiFor, parse, checkWindowsOutput, DEFAULT_UPDATE_URL } from '../../scripts/build.mjs';
import { spkiBase64 } from '../../scripts/bridge-trust-gate.mjs';

const owner = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pem = owner.publicKey.export({ type: 'spki', format: 'pem' });
const spki = owner.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const installer = Buffer.from('MZ fake installer bytes of SSAM Agent 0.2.9');
const sha512 = createHash('sha512').update(installer).digest('base64');
const file = 'ssam-agent-app-0.2.9-setup.exe';
const info = (extra = {}) => ({ version: '0.2.9', files: [{ url: file, sha512, size: installer.length }], path: file, sha512, ...extra });
const downloaded = { sha512, size: installer.length };
const statement = (extra = {}) => statementFor({ version: '0.2.9', file, size: installer.length, sha512, createdAt: '2026-11-08T00:00:00Z', ...extra });
const signed = (extra = {}, key = owner.privateKey) => signStatement(statement(extra), key);
const problem = (text, extra = {}) => updateStatementProblem({ text, publicKey: spki, info: info(), downloaded, current: '0.2.8', ...extra });

test('a valid signed statement allows the install, with the key as base64 SPKI or as PEM', () => {
  assert.equal(problem(signed()), null);
  assert.equal(updateStatementProblem({ text: signed(), publicKey: pem, info: info(), downloaded, current: '0.2.8' }), null);
  assert.equal(readStatement(signed(), spki).statement.version, '0.2.9');
});

test('a missing statement is refused with UPDATE_SIGNATURE_MISSING', () => {
  for (const text of [null, '', '   ']) assert.equal(problem(text).code, UPDATE_CODES.SIGNATURE_MISSING);
});

test('an invalid signature, another key, a tampered payload or a malformed envelope is refused with UPDATE_SIGNATURE_INVALID', () => {
  assert.equal(problem(signed({}, other.privateKey)).code, UPDATE_CODES.SIGNATURE_INVALID, 'wrong key');
  const envelope = JSON.parse(signed());
  const tampered = JSON.parse(Buffer.from(envelope.payload, 'base64')); tampered.sha512 = createHash('sha512').update('evil').digest('base64');
  assert.equal(problem(JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(tampered)).toString('base64') })).code, UPDATE_CODES.SIGNATURE_INVALID, 'tampered payload');
  const flipped = Buffer.from(envelope.signature, 'base64'); flipped[5] ^= 1;
  assert.equal(problem(JSON.stringify({ ...envelope, signature: flipped.toString('base64') })).code, UPDATE_CODES.SIGNATURE_INVALID, 'flipped signature');
  for (const text of ['{', '{"schema":2}', JSON.stringify({ schema: 1, payload: 'x', signature: 'y' }), 'x'.repeat(20000)]) assert.equal(problem(text).code, UPDATE_CODES.SIGNATURE_INVALID);
});

test('a signature over the bare payload (no domain), e.g. a bridge manifest signed by the same key, is refused', () => {
  const payload = Buffer.from(JSON.stringify(statement()));
  const bare = JSON.stringify({ schema: 1, payload: payload.toString('base64'), signature: sign(null, payload, owner.privateKey).toString('base64') });
  assert.equal(problem(bare).code, UPDATE_CODES.SIGNATURE_INVALID);
  assert.equal(UPDATE_STATEMENT_DOMAIN, 'SSAM-AGENT-UPDATE-STATEMENT/1\n');
});

test('a statement for other bytes, another version, another installer or another platform is refused', () => {
  assert.equal(problem(signed(), { downloaded: { sha512: createHash('sha512').update('other').digest('base64'), size: installer.length } }).code, UPDATE_CODES.STATEMENT_MISMATCH, 'tampered download');
  assert.equal(problem(signed(), { downloaded: { sha512, size: installer.length + 1 } }).code, UPDATE_CODES.STATEMENT_MISMATCH, 'other size');
  assert.equal(problem(signed(), { downloaded: null }).code, UPDATE_CODES.STATEMENT_MISMATCH, 'unreadable download');
  assert.equal(problem(signed(), { info: info({ version: '0.3.0' }) }).code, UPDATE_CODES.STATEMENT_MISMATCH, 'latest.yml announces another version');
  assert.equal(problem(signed({ file: 'ssam-agent-app-0.2.9-other.exe' })).code, UPDATE_CODES.STATEMENT_MISMATCH, 'another installer name');
  assert.equal(problem(signed(), { info: info({ files: [{ url: file, sha512: createHash('sha512').update('x').digest('base64'), size: installer.length }] }) }).code, UPDATE_CODES.STATEMENT_MISMATCH, 'latest.yml sha512 differs');
  const mac = JSON.parse(Buffer.from(JSON.parse(signed()).payload, 'base64')); mac.platform = 'darwin';
  const payload = Buffer.from(JSON.stringify(mac));
  const macText = JSON.stringify({ schema: 1, payload: payload.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from(UPDATE_STATEMENT_DOMAIN), payload]), owner.privateKey).toString('base64') });
  assert.equal(problem(macText).code, UPDATE_CODES.SIGNATURE_INVALID, 'a signed statement for macOS is not a Windows update');
});

test('a downgrade or the same version is refused with UPDATE_DOWNGRADE, even when genuinely signed', () => {
  assert.equal(problem(signed(), { current: '0.2.9' }).code, UPDATE_CODES.DOWNGRADE);
  assert.equal(problem(signed(), { current: '0.3.0' }).code, UPDATE_CODES.DOWNGRADE);
  assert.equal(problem(signed(), { current: 'unknown' }).code, UPDATE_CODES.DOWNGRADE);
});

test('without a pinned key the Windows app never updates itself: UPDATE_KEY_MISSING', () => {
  assert.equal(UPDATE_PUBLIC_KEY, '', 'a checkout (no build define) pins no key');
  assert.equal(problem(signed(), { publicKey: '' }).code, UPDATE_CODES.KEY_MISSING);
  assert.equal(problem(signed(), { publicKey: other.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }).code, UPDATE_CODES.KEY_MISSING, 'a non-SPKI value is no key');
  assert.match(updateTrustProblem({ platform: 'win32', isPackaged: true, updatePublicKey: '' }), /UPDATE_KEY_MISSING/);
  assert.equal(updateTrustProblem({ platform: 'win32', isPackaged: true, updatePublicKey: spki }), null);
  assert.equal(updateTrustProblem({ platform: 'darwin', isPackaged: true, updatePublicKey: '' }), null, 'macOS keeps its own code-signature check');
});

test('the statement url is on the feed, named after the installer of latest.yml', () => {
  assert.equal(statementUrl('https://dist.ssam.pro/u/ssam-agent/', file), 'https://dist.ssam.pro/u/ssam-agent/' + file + '.ed25519.json');
  assert.equal(installerName('https://elsewhere.example/x/' + file), file);
  for (const bad of ['../x.exe', 'x.zip', 'a/b%2F..%2Fc.exe', '%E0%A4%A.exe', '']) assert.equal(installerName(bad), bad === '../x.exe' ? 'x.exe' : null);
});

test('verifyWindowsUpdate: the downloaded file, the fetched statement and the installer version decide', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-update-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const downloadedFile = path.join(dir, file); fs.writeFileSync(downloadedFile, installer);
  const asked = [];
  const base = { info: info({ downloadedFile }), feed: DEFAULT_UPDATE_URL, currentVersion: '0.2.8', publicKey: spki, readInstaller: () => ({ productVersion: '0.2.9', productName: 'SSAM Agent' }) };
  assert.equal(await verifyWindowsUpdate({ ...base, fetchText: async url => { asked.push(url); return signed(); } }), null);
  assert.deepEqual(asked, [DEFAULT_UPDATE_URL + '/' + file + '.ed25519.json']);
  assert.equal((await verifyWindowsUpdate({ ...base, fetchText: async () => null })).code, UPDATE_CODES.SIGNATURE_MISSING);
  assert.equal((await verifyWindowsUpdate({ ...base, fetchText: async () => signed({}, other.privateKey) })).code, UPDATE_CODES.SIGNATURE_INVALID);
  assert.equal((await verifyWindowsUpdate({ ...base, readInstaller: () => ({ productVersion: '0.2.7', productName: 'SSAM Agent' }), fetchText: async () => signed() })).code, UPDATE_CODES.INSTALLER_MISMATCH);
  fs.writeFileSync(downloadedFile, Buffer.concat([installer, Buffer.from('x')]));
  assert.equal((await verifyWindowsUpdate({ ...base, fetchText: async () => signed() })).code, UPDATE_CODES.STATEMENT_MISMATCH, 'the file on disk changed after the download');
  let fetched = 0;
  assert.equal((await verifyWindowsUpdate({ ...base, publicKey: '', fetchText: async () => { fetched++; return signed(); } })).code, UPDATE_CODES.KEY_MISSING);
  assert.equal(fetched, 0, 'without a key nothing is fetched');
});

test('fetchStatementText: only a 200 with a small body counts', async () => {
  const response = (status, body, headers = {}) => async () => new Response(body, { status, headers });
  assert.equal(await fetchStatementText('u', { fetchImpl: response(200, 'abc') }), 'abc');
  assert.equal(await fetchStatementText('u', { fetchImpl: response(404, 'abc') }), null);
  assert.equal(await fetchStatementText('u', { fetchImpl: response(200, 'x'.repeat(17000)) }), null);
  assert.equal(await fetchStatementText('u', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('sign-windows-update: signs the dist of this version, verifies it, never prints the key, and refuses a key other than the pinned one', async t => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-dist-')); t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dist, file), installer);
  fs.writeFileSync(path.join(dist, 'latest.yml'), `version: 0.2.9\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-11-08T00:00:00.000Z'\n`);
  const pinned = path.join(dist, 'pinned.pem'); fs.writeFileSync(pinned, pem);
  const privatePem = owner.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => signDist(dist, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), { appVersion: '0.2.9', expectPublicKey: pinned }), /not the pinned public key/);
  assert.throws(() => signDist(dist, privatePem, { appVersion: '0.2.8' }), /this app is 0\.2\.8/);
  assert.throws(() => signDist(dist, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { appVersion: '0.2.9' }), /Ed25519/);
  const result = signDist(dist, privatePem, { appVersion: '0.2.9', expectPublicKey: pinned });
  assert.equal(result.statement, file + '.ed25519.json');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|BEGIN/);
  const text = fs.readFileSync(path.join(dist, result.statement), 'utf8');
  assert.doesNotMatch(text, /PRIVATE/);
  assert.equal(updateStatementProblem({ text, publicKey: spki, info: info(), downloaded, current: '0.2.8' }), null, 'what the publisher writes is what the app accepts');
  fs.writeFileSync(path.join(dist, file), Buffer.concat([installer, Buffer.from('!')]));
  assert.throws(() => signDist(dist, privatePem, { appVersion: '0.2.9' }), /not the one latest\.yml announces/);
  assert.throws(() => parseArgs([]), /--dist/);
  assert.throws(() => parseArgs(['--dist', 'd', '--private-key', 'k']), /unknown option/, 'the key is never an argument');
});

test('build: a Windows release takes the trust key as its input, pins it in the main bundle, and carries no publisherName', t => {
  const env = { ...process.env }; delete env.SSAM_WIN_CERT_SHA1; delete env.SSAM_WIN_PUBLISHER_NAME;
  const saved = { a: process.env.SSAM_WIN_CERT_SHA1, b: process.env.SSAM_WIN_PUBLISHER_NAME };
  delete process.env.SSAM_WIN_CERT_SHA1; delete process.env.SSAM_WIN_PUBLISHER_NAME;
  t.after(() => { if (saved.a !== undefined) process.env.SSAM_WIN_CERT_SHA1 = saved.a; if (saved.b !== undefined) process.env.SSAM_WIN_PUBLISHER_NAME = saved.b; });
  assert.throws(() => parse(['--platform', 'win', '--native', 'x.exe']), /needs --trust-public-key/);
  const options = parse(['--platform', 'win', '--native', 'x.exe', '--trust-public-key', 'owner.pem']);
  assert.equal(options.ed25519Release, true); assert.equal(options.signing, undefined); assert.equal(options.noUpdates, false);
  assert.equal(updateSpkiFor(options, () => pem), spki);
  assert.equal(updateSpkiFor({ ...options, noUpdates: true }, () => pem), '');
  assert.equal(updateSpkiFor({ platform: 'win', testUnsigned: true, noUpdates: true }, () => pem), '');
  assert.equal(spkiBase64(pem), spki);
  assert.equal(mainBundleKeyProblem(`const k = "${spki}";`, spki), null);
  assert.match(mainBundleKeyProblem('const k = "";', spki), /no update key/);
  assert.match(mainBundleKeyProblem(`const k = "${other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}";`, spki), /other key/);
  assert.match(mainBundleKeyProblem(`const k = "${spki}";`, ''), /takes none/);
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-win-ed-')); t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const resources = path.join(dist, 'win-unpacked', 'resources'); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(dist, 'latest.yml'), 'version: 0.2.9\n');
  fs.writeFileSync(path.join(resources, 'app-update.yml'), `provider: generic\nurl: ${DEFAULT_UPDATE_URL}\nchannel: latest\nupdaterCacheDirName: ssam-agent-app-updater\n`);
  assert.doesNotThrow(() => checkWindowsOutput(dist, options, { pack: () => [] }));
  fs.writeFileSync(path.join(resources, 'app-update.yml'), `provider: generic\nurl: ${DEFAULT_UPDATE_URL}\nchannel: latest\npublisherName:\n  - Someone\n`);
  assert.throws(() => checkWindowsOutput(dist, options, { pack: () => [] }), /not Authenticode-signed/);
});

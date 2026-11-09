// scripts/sign-windows-update.ps1 (review B1-B3 of 0.2.8): the node.exe that receives the private key is an absolute path,
// never PATH or the current directory; -ExpectPublicKey is required; only the manifest key of the vault is decrypted (a
// vault whose other values cannot be decrypted still signs); both output streams are drained. End to end with a throwaway
// DPAPI vault in a temporary folder holding an ephemeral test key (never the vigia vault). Windows only.
// SSAM_SIGN_PS1 may name another copy of the script (to run these tests against an older one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readStatement } from '../../src/main/core/update-signature.mjs';

const box = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = process.env.SSAM_SIGN_PS1 || path.join(box, 'scripts', 'sign-windows-update.ps1');
const vaultLib = path.resolve(path.dirname(script), '..', '..', 'server', 'deploy', 'vigia', 'vault.ps1');
const windows = process.platform === 'win32' ? false : 'Windows PowerShell and DPAPI';
const ps = (args, input) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 120000 });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-sign-ps1-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dist = path.join(dir, 'dist'); fs.mkdirSync(dist);
  const version = JSON.parse(fs.readFileSync(path.join(box, 'package.json'), 'utf8')).version;
  const file = `ssam-agent-app-${version}-setup.exe`; const installer = Buffer.from('test installer ' + version);
  const sha512 = createHash('sha512').update(installer).digest('base64');
  fs.writeFileSync(path.join(dist, file), installer);
  fs.writeFileSync(path.join(dist, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-11-08T00:00:00.000Z'\n`);
  const keys = generateKeyPairSync('ed25519');
  const pinned = path.join(dir, 'pinned.pem'); fs.writeFileSync(pinned, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const vault = path.join(dir, 'vault.json');
  // The other values are not DPAPI blobs: a script that decrypts the whole vault fails on them.
  const made = ps(['-Command', `. '${vaultLib}'; $k = [Console]::In.ReadToEnd(); @{ schema = 2; values = @{ manifestPrivateKey = (Protect-VigiaValue $k); journalKey = 'not-a-dpapi-blob'; sshPrivateKey = 'not-a-dpapi-blob' } } | ConvertTo-Json | Set-Content -LiteralPath '${vault}' -Encoding UTF8`],
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(made.status, 0, made.stderr);
  return { dir, dist, file, pinned, vault, keys };
}

test('sign-windows-update.ps1 refuses a node.exe that is not an absolute path, before the vault is read', { skip: windows }, t => {
  const f = fixture(t);
  for (const node of ['node', 'node.exe', '.\\node.exe', 'C:\\Program Files\\nodejs\\cmd.exe']) {
    const run = ps(['-File', script, '-Dist', f.dist, '-ExpectPublicKey', f.pinned, '-Vault', f.vault, '-Node', node]);
    assert.notEqual(run.status, 0, node);
    assert.match(run.stderr + run.stdout, /absolute path of node\.exe/, node);
  }
  assert.equal(fs.existsSync(path.join(f.dist, f.file + '.ed25519.json')), false);
});

test('sign-windows-update.ps1 requires -ExpectPublicKey', { skip: windows }, t => {
  const f = fixture(t);
  const run = ps(['-File', script, '-Dist', f.dist, '-Vault', f.vault, '-Node', process.execPath]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /ExpectPublicKey/);
  assert.equal(fs.existsSync(path.join(f.dist, f.file + '.ed25519.json')), false);
});

test('sign-windows-update.ps1 decrypts only the manifest key, signs, and prints no key material', { skip: windows }, t => {
  const f = fixture(t);
  const run = ps(['-File', script, '-Dist', f.dist, '-ExpectPublicKey', f.pinned, '-Vault', f.vault, '-Node', process.execPath]);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE KEY|BEGIN/);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.ok, true);
  assert.deepEqual(result.publish, ['latest.yml', f.file, f.file + '.blockmap', f.file + '.ed25519.json']);
  const text = fs.readFileSync(path.join(f.dist, f.file + '.ed25519.json'), 'utf8');
  assert.equal(readStatement(text, f.keys.publicKey).statement?.file, f.file);
});

test('sign-windows-update.ps1 refuses a vault key that is not the pinned one', { skip: windows }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.pinned, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const run = ps(['-File', script, '-Dist', f.dist, '-ExpectPublicKey', f.pinned, '-Vault', f.vault, '-Node', process.execPath]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr + run.stdout, /not the pinned public key/);
});

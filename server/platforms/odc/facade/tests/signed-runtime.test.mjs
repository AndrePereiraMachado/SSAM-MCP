import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { signedRuntime, bridgeClientError } from '../signed-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-signing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'a'.repeat(32), base = path.join(root, '.local', 'signed-runtime');
  const dir = path.join(base, id), source = path.join(root, 'studio', 'bridge', 'client');
  for (const folder of [source, path.join(dir, 'client'), path.join(dir, 'bridge')]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(source, 'Program.cs'), 'const string Version = "v30";');
  const names = ['client/ODC3.Bridge.Client.dll', 'client/ODC3.Bridge.Client.deps.json',
    'client/ODC3.Bridge.Client.runtimeconfig.json', 'client/Microsoft.Diagnostics.NETCore.Client.dll',
    'bridge/ODC3.Bridge.v30.dll'];
  const manifest = { schema: 1, version: 'v30', files: names.map(name => {
    // These are inert text fixtures. This tests selection integrity, not Authenticode.
    fs.writeFileSync(path.join(dir, name), name);
    return { path: name, sha256: hash(name), ...(name.endsWith('.dll') ? { signature: 'Valid' } : {}) };
  }) };
  const select = () => {
    const content = JSON.stringify(manifest);
    fs.writeFileSync(path.join(dir, 'verified.json'), content);
    fs.writeFileSync(path.join(base, 'selected.json'), JSON.stringify({ schema: 1, id, sha256: hash(content) }));
  };
  return { root, dir, base, source, manifest, select };
}

test('no signed selection preserves the existing runtime', t => {
  assert.equal(signedRuntime(fixture(t).root), null);
});
test('selection returns the matching client and bridge', t => {
  const f = fixture(t); f.select();
  assert.deepEqual(signedRuntime(f.root), { client: path.join(f.dir, 'client', 'ODC3.Bridge.Client.dll'),
    bridge: path.join(f.dir, 'bridge', 'ODC3.Bridge.v30.dll'), version: 'v30' });
});
test('changed binary fails without falling back to the unsigned runtime', t => {
  const f = fixture(t); f.select(); fs.appendFileSync(path.join(f.dir, 'client', 'ODC3.Bridge.Client.dll'), 'changed');
  assert.throws(() => signedRuntime(f.root), /file_changed/);
});
test('changed verified manifest is refused', t => {
  const f = fixture(t); f.select(); fs.appendFileSync(path.join(f.dir, 'verified.json'), ' ');
  assert.throws(() => signedRuntime(f.root), /manifest_changed/);
});
test('new protocol needs a newly verified package', t => {
  const f = fixture(t); f.select(); fs.writeFileSync(path.join(f.source, 'Program.cs'), 'const string Version = "v31";');
  assert.throws(() => signedRuntime(f.root), /protocol_changed/);
});
test('unsigned metadata cannot be selected', t => {
  const f = fixture(t); f.manifest.files[0].signature = 'NotSigned'; f.select();
  assert.throws(() => signedRuntime(f.root), /signature_not_verified/);
});
test('missing required file is refused', t => {
  const f = fixture(t); f.manifest.files.pop(); f.select();
  assert.throws(() => signedRuntime(f.root), /incomplete/);
});
test('unverified dependency beside client is refused', t => {
  const f = fixture(t); f.select(); fs.writeFileSync(path.join(f.dir, 'client', 'extra.dll'), 'extra');
  assert.throws(() => signedRuntime(f.root), /unverified_file/);
});
test('manifest cannot escape the bundle directory', t => {
  const f = fixture(t); f.manifest.files.push({ path: '../outside.json', sha256: 'anything' }); f.select();
  assert.throws(() => signedRuntime(f.root), /invalid_path/);
});
test('application-control HRESULT survives multiline errors', () => {
  assert.match(bridgeClientError({ stderr: 'Unhandled exception\nFile blocked (0x800711C7)' }).message, /odc_application_control_blocked/);
  assert.equal(bridgeClientError({ stderr: 'Pipe timed out\nDetails' }).message, 'Pipe timed out');
});

import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { signedRuntime, bridgeClientError, declaredBridgeVersions, bridgeFor, installedOdcStudioRuntime } from '../signed-runtime.mjs';

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

// U1 (v106/v107): one source, one bridge name per ODC Studio runtime (client/Program.cs Version for net10, EarlierVersion for
// net8). A selection signs the bridge of one runtime; the Studio's runtime picks the name, the build folder and the signed copy.
const BOTH = 'const string Version = "v106";\nconst string EarlierVersion = "v107";';
test('the declared names: Version for the net10 Studios, EarlierVersion for the net8 ones', () => {
  assert.deepEqual(declaredBridgeVersions(BOTH), { 'net10.0': 'v106', 'net8.0': 'v107' });
  assert.deepEqual(declaredBridgeVersions('const string Version = "v97";'), { 'net10.0': 'v97', 'net8.0': 'v97' });
});
test('a local net8 Studio gets the net8 name in the net8 build folder, a net10 or unknown one the net10 name', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'Program.cs'), BOTH);
  const bin = tfm => path.join(f.root, 'studio', 'bridge', 'bin', 'Release', tfm);
  assert.deepEqual(bridgeFor(f.root, 'net8.0'), { version: 'v107', runtime: 'net8.0', path: path.join(bin('net8.0'), 'ODC3.Bridge.v107.dll') });
  assert.deepEqual(bridgeFor(f.root, 'net10.0'), { version: 'v106', runtime: 'net10.0', path: path.join(bin('net10.0'), 'ODC3.Bridge.v106.dll') });
  assert.equal(bridgeFor(f.root, null).version, 'v106');
});
test('a signed selection of the net8 bridge serves a net8 Studio and never a net10 one; v101 needs signing again', t => {
  const f = fixture(t);
  f.manifest.version = 'v107';
  f.manifest.files = f.manifest.files.map(entry => entry.path === 'bridge/ODC3.Bridge.v30.dll' ? { ...entry, path: 'bridge/ODC3.Bridge.v107.dll' } : entry);
  fs.rmSync(path.join(f.dir, 'bridge', 'ODC3.Bridge.v30.dll'));
  fs.writeFileSync(path.join(f.dir, 'bridge', 'ODC3.Bridge.v107.dll'), 'bridge/ODC3.Bridge.v30.dll');
  f.select(); fs.writeFileSync(path.join(f.source, 'Program.cs'), BOTH);
  assert.equal(signedRuntime(f.root, { runtime: 'net8.0' }).version, 'v107');
  assert.equal(signedRuntime(f.root).version, 'v107', 'without a runtime either declared name is accepted');
  assert.throws(() => signedRuntime(f.root, { runtime: 'net10.0' }), /protocol_changed/);
  fs.writeFileSync(path.join(f.source, 'Program.cs'), 'const string Version = "v101";\nconst string EarlierVersion = "v102";');
  assert.throws(() => signedRuntime(f.root), /protocol_changed/);
});
test('the installed ODC Studio runtime is read from its own runtimeconfig.json, null when unreadable', t => {
  const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-programfiles-'));
  t.after(() => fs.rmSync(programFiles, { recursive: true, force: true }));
  assert.equal(installedOdcStudioRuntime(programFiles), null);
  const folder = path.join(programFiles, 'OutSystems', 'ODC Studio', 'ODC Studio'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ODCStudio.runtimeconfig.json'), '{"runtimeOptions":{"tfm":"net8.0"}}');
  assert.equal(installedOdcStudioRuntime(programFiles), 'net8.0');
});
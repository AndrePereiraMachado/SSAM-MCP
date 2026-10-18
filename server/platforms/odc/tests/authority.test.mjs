// The authority and the identity of the resident reader (lane F, platforms/odc/facade/reader-client.mjs), in the
// checkout and in a release. The release answers come from opts {release: true, env}, as in release-layout.mjs, so no
// bundle is needed. Every case uses its own env object with temporary USERPROFILE, HOME, APPDATA, LOCALAPPDATA and
// ANVIL_AUTHORITY_DIR (never process.env), under SSAM_TEST_TMP when set; no case reads a bridge.key.
import '../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE, authorityDir } from '../facade/release-layout.mjs';
import { readerAuthority, readerGeneration } from '../facade/reader-client.mjs';

function tempProfile(t) {
  const base = fs.mkdtempSync(path.join(process.env.SSAM_TEST_TMP || os.tmpdir(), 'ssam-authority-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  const env = { USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: path.join(base, 'inherited-authority') };
  for (const dir of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  const writeConfig = config => {
    const file = path.join(profile, '.ssam-hybrid', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  };
  return { base, profile, env, writeConfig, standard: path.join(profile, '.anvil', 'authority') };
}

test('checkout: ANVIL_AUTHORITY_DIR, else %LOCALAPPDATA%\\Anvil\\authority, as before', t => {
  assert.equal(RELEASE, false);
  const { env } = tempProfile(t);
  assert.equal(readerAuthority({ env }), env.ANVIL_AUTHORITY_DIR);
  const { ANVIL_AUTHORITY_DIR, ...withoutVariable } = env;
  assert.equal(readerAuthority({ release: false, env: withoutVariable }), path.join(env.LOCALAPPDATA, 'Anvil', 'authority'));
});

test('release: %USERPROFILE%\\.anvil\\authority; the inherited ANVIL_AUTHORITY_DIR and LOCALAPPDATA are never read', t => {
  const { env, standard } = tempProfile(t);
  const release = { release: true, env };
  assert.equal(readerAuthority(release), standard);
  assert.notEqual(readerAuthority(release), env.ANVIL_AUTHORITY_DIR);
  assert.notEqual(readerAuthority(release), path.join(env.LOCALAPPDATA, 'Anvil', 'authority'));
  const { ANVIL_AUTHORITY_DIR, ...withoutVariable } = env;
  assert.equal(readerAuthority({ release: true, env: withoutVariable }), standard);
  // The same rule the child processes get (release-layout childEnv exports authorityDir).
  assert.equal(readerAuthority(release), authorityDir(release));
});

test('release: config.json authorityDir comes first; empty is the default; relative or not a string is refused', t => {
  const { base, env, standard, writeConfig } = tempProfile(t);
  const release = { release: true, env };
  const own = path.join(base, 'own-authority');
  writeConfig({ authorityDir: own });
  assert.equal(readerAuthority(release), own);
  writeConfig({ authorityDir: base + '\\sub\\..\\own-authority' });
  assert.equal(readerAuthority(release), own);
  writeConfig({ authorityDir: '' });
  assert.equal(readerAuthority(release), standard);
  writeConfig({ ports: { first: 40000, last: 40019 } });
  assert.equal(readerAuthority(release), standard);
  writeConfig({ authorityDir: 'relative\\authority' });
  assert.throws(() => readerAuthority(release), /absolute/);
  writeConfig({ authorityDir: 42 });
  assert.throws(() => readerAuthority(release), /absolute/);
  writeConfig('not json');
  assert.throws(() => readerAuthority(release), /config\.json/);
  // The checkout never reads config.json.
  assert.equal(readerAuthority({ release: false, env }), env.ANVIL_AUTHORITY_DIR);
});

function fakeRelease(t) {
  const { base, env } = tempProfile(t);
  const release = path.join(base, 'release');
  const manifest = path.join(release, 'release.json');
  const core = path.join(release, 'runtime', 'dotnet', 'shared', 'Microsoft.NETCore.App', '10.0.0', 'System.Private.CoreLib.dll');
  fs.mkdirSync(path.dirname(core), { recursive: true });
  fs.writeFileSync(core, 'AAAA');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ssam-release/1', version: '1.0.0' }));
  const bin = path.join(base, 'bin'), runtime = path.join(base, 'studio');
  fs.mkdirSync(bin); fs.mkdirSync(runtime);
  const dll = path.join(bin, 'reader.dll');
  fs.writeFileSync(dll, 'AAAA'); fs.writeFileSync(path.join(runtime, 'OutSystems.Model.dll'), 'AAAA');
  return { base, env, release, manifest, core, dll, runtime, opts: { release: true, env: { ...env, SSAM_RELEASE_ROOT: release } } };
}

test('release: the reader generation is the release identity and the packaged runtime, not DOTNET_ROOT', t => {
  const { base, env, manifest, core, dll, runtime, opts } = fakeRelease(t);
  const first = readerGeneration(dll, runtime, opts);
  assert.equal(readerGeneration(dll, runtime, opts), first);
  // An inherited DOTNET_ROOT is not the runtime a release reader runs on.
  assert.equal(readerGeneration(dll, runtime, { ...opts, env: { ...opts.env, DOTNET_ROOT: path.join(base, 'other-dotnet') } }), first);
  // The checkout hashes this module's source instead of release.json: another generation over the same files.
  assert.notEqual(readerGeneration(dll, runtime, { release: false, env: { ...env, DOTNET_ROOT: path.join(base, 'release', 'runtime', 'dotnet') } }), first);
  // Another release is another generation.
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ssam-release/1', version: '1.0.1' }));
  const second = readerGeneration(dll, runtime, opts);
  assert.notEqual(second, first);
  // The packaged runtime is part of it.
  fs.writeFileSync(core, 'AAAAA');
  assert.notEqual(readerGeneration(dll, runtime, opts), second);
});

test('release: without release.json there is no reader generation', t => {
  const { base, dll, runtime, opts } = fakeRelease(t);
  const empty = path.join(base, 'not-a-release');
  fs.mkdirSync(empty);
  assert.throws(() => readerGeneration(dll, runtime, { ...opts, env: { ...opts.env, SSAM_RELEASE_ROOT: empty } }), /Not an SSAM release folder/);
});

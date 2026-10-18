// platforms/odc/facade/release-layout.mjs (lane A): the checkout answers are today's values (workspace.mjs and
// studio-session.mjs included), the release answers follow the contract of docs/DISTRIBUICAO.md, and a child started
// with childEnv writes only inside the temporary profile it was given.
import '../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as layout from '../facade/release-layout.mjs';
import { odcRoot, workspaceRoot, anvilRoot, o11Lane } from '../facade/workspace.mjs';
import { connectionFile as sessionConnectionFile } from '../facade/studio-session.mjs';

const facadeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'facade');
const repo = path.resolve(facadeDir, '..', '..', '..');

function fakeRelease() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-layout-test-'));
  const release = path.join(tmp, 'releases', '2026.10.1');
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(path.join(release, 'runtime', 'node'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ schema: 'ssam-release/1', version: '2026.10.1' }));
  const opts = { release: true, env: { USERPROFILE: profile }, execPath: path.join(release, 'runtime', 'node', 'node.exe') };
  const write = (relative, value) => {
    const file = path.join(profile, '.ssam-hybrid', ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { tmp, release, profile, opts, write, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('the checkout answers are the values the checkout code uses today', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repo, '.ssam-workspace.json'), 'utf8'));
  assert.equal(layout.RELEASE, false);
  assert.equal(layout.root(), repo);
  assert.equal(workspaceRoot, repo);
  assert.equal(odcRoot, path.resolve(facadeDir, '..'));
  assert.equal(anvilRoot, process.env.ANVIL_ROOT ?? path.join(repo, config.kernel));
  assert.equal(layout.kernelRoot(), anvilRoot);
  assert.deepEqual(layout.workspaceConfig(), config);
  assert.equal(layout.releaseManifest(), null);
  assert.deepEqual(layout.readConfig(), {});
  assert.equal(layout.dataRoot(), path.join(repo, '.local'));
  assert.equal(layout.dotnetPath(), 'dotnet');
  assert.equal(layout.connectionFile(), sessionConnectionFile(anvilRoot, o11Lane.lane));
  assert.equal(layout.layoutPath('platforms/odc/facade', null), facadeDir);
  const env = { ANVIL_ROOT: 'K:\\kernel' };
  assert.equal(layout.laneDataDir('o11', { env: { ...env, ANVIL_LANE: 'ss4' } }), path.join('K:\\kernel', '.local'));
  assert.equal(layout.laneDataDir('o11', { env: { ...env, ANVIL_LANE: 'SS5' } }), path.join('K:\\kernel', '.local', 'lane-ss5'));
  assert.equal(layout.laneDataDir('odc', { env }), path.join('K:\\kernel', '.local', 'lane-odc'));
  assert.equal(layout.bridgePort({ env: { ANVIL_BRIDGE_PORT: '4600' } }), 4600);
  assert.equal(layout.bridgePort({ env: { ANVIL_LANE: 'ss5' } }), 4536);
  assert.equal(layout.bridgePort({ env: { ANVIL_LANE: 'ss4' } }), 4516);
  assert.equal(layout.authorityDir({ env: { ANVIL_AUTHORITY_DIR: 'X:\\authority' } }), 'X:\\authority');
  assert.equal(layout.authorityDir({ env: { USERPROFILE: 'C:\\person' } }), path.join('C:\\person', '.anvil', 'authority'));
  const base = { PATH: 'p', ANVIL_X: '1' };
  const child = layout.childEnv(base);
  assert.deepEqual(child, base);
  assert.notEqual(child, base);
  assert.deepEqual(layout.portRange(), { first: 4516, last: 4535, source: 'default',
    bridges: [4516, 4517, 4518, 4519, 4520, 4521, 4522, 4523, 4524, 4525], workers: [4526, 4527, 4528, 4529, 4530, 4531, 4532, 4533, 4534, 4535] });
  assert.throws(() => layout.laneDataDir('ss4'), /Unknown lane/);
});

test('the release answers follow the contract', () => {
  const fake = fakeRelease();
  try {
    const { opts, release, profile } = fake;
    const home = path.join(profile, '.ssam-hybrid');
    assert.equal(layout.root(opts), release);
    assert.equal(layout.root({ ...opts, execPath: 'C:\\elsewhere\\node.exe', env: { ...opts.env, SSAM_RELEASE_ROOT: release } }), release);
    assert.throws(() => layout.root({ ...opts, execPath: path.join(fake.tmp, 'a', 'b', 'node.exe') }), /no release\.json/);
    assert.equal(layout.releaseManifest(opts).version, '2026.10.1');
    assert.equal(layout.workspaceConfig(opts), null);
    assert.equal(layout.kernelRoot(opts), release);
    assert.equal(layout.layoutPath('platforms/odc/facade/x.json', 'app/data/x.json', opts), path.join(release, 'app', 'data', 'x.json'));
    assert.throws(() => layout.layoutPath('scripts/lanes.py', null, opts), /Not part of the release layout/);
    assert.equal(layout.userRoot(opts), home);
    assert.equal(layout.dataRoot(opts), path.join(home, 'data'));
    assert.equal(layout.laneDataDir('odc', opts), path.join(home, 'data', 'odc'));
    assert.equal(layout.licenseRoot(opts), path.join(home, 'license'));
    assert.equal(layout.configFile(opts), path.join(home, 'config.json'));
    assert.equal(layout.dotnetPath(opts), path.join(release, 'runtime', 'dotnet', 'dotnet.exe'));
    assert.equal(layout.connectionFile('o11', opts), path.join(home, 'data', 'o11', 'connection.json'));
    assert.equal(layout.hookExchangeDir(4242, 1790000000123, opts), path.join(home, 'data', 'o11', 'runtime-connect', '4242-1790000000123'));
    assert.throws(() => layout.hookExchangeDir(0, 1, opts), /positive pid/);
    // defaults, without config.json; ANVIL_AUTHORITY_DIR inherited from elsewhere is ignored in release
    assert.equal(layout.authorityDir({ ...opts, env: { ...opts.env, ANVIL_AUTHORITY_DIR: 'X:\\operational' } }), path.join(profile, '.anvil', 'authority'));
    assert.equal(layout.portRange(opts).source, 'default');
    assert.equal(layout.bridgePort(opts), 4516);
    assert.equal(layout.readConnection('o11', opts), null);
    // config.json and the connection record
    fake.write('config.json', { ports: { first: 4600, last: 4619 }, authorityDir: path.join(home, 'authority') });
    assert.equal(layout.authorityDir(opts), path.join(home, 'authority'));
    assert.deepEqual([layout.portRange(opts).bridges[0], layout.portRange(opts).workers[9]], [4600, 4619]);
    assert.equal(layout.bridgePort(opts), 4600);
    fake.write('data/o11/connection.json', { ok: true, port: 4604, studioDir: 'D:\\Studio' });
    assert.equal(layout.bridgePort(opts), 4604);
    assert.equal(layout.bridgePort({ ...opts, env: { ...opts.env, ANVIL_BRIDGE_PORT: '4999' } }), 4604, 'the facade is not a child: it does not read ANVIL_BRIDGE_PORT');
    const child = layout.childEnv({ PATH: 'p', ANVIL_AUTHORITY_DIR: 'X:\\operational' }, opts);
    assert.deepEqual(child, { PATH: 'p', ANVIL_BRIDGE_PORT: '4604', ANVIL_AUTHORITY_DIR: path.join(home, 'authority'), USERPROFILE: profile,
      SSAM_HYBRID_HOME: home, SSAM_DATA_DIR: path.join(home, 'data'), DOTNET_ROOT: path.join(release, 'runtime', 'dotnet') });
    assert.equal(layout.childEnv({}, { ...opts, port: 4610 }).ANVIL_BRIDGE_PORT, '4610');
    // invalid configuration is an error, never a silent default
    fake.write('config.json', { ports: { first: 4600, last: 4610 } });
    assert.throws(() => layout.portRange(opts), /ports must be/);
    fake.write('config.json', { authorityDir: 'relative\\folder' });
    assert.throws(() => layout.authorityDir(opts), /absolute path/);
    fake.write('config.json', '{ not json');
    assert.throws(() => layout.readConfig(opts), /not valid JSON/);
  } finally { fake.done(); }
});

test('a child started with childEnv writes only inside the temporary profile', () => {
  const fake = fakeRelease();
  try {
    const { profile, opts } = fake;
    const base = { ...process.env, USERPROFILE: profile, HOME: profile,
      APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local') };
    const env = layout.childEnv(base, { ...opts, env: base });
    const script = "const fs=require('fs'),path=require('path');" +
      "for (const v of ['USERPROFILE','APPDATA','LOCALAPPDATA','SSAM_DATA_DIR']) { const d=path.join(process.env[v],'guard-probe'); fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(path.join(d,v+'.txt'),v); }" +
      "console.log(JSON.stringify(['USERPROFILE','APPDATA','LOCALAPPDATA','SSAM_DATA_DIR'].map(v=>path.join(process.env[v],'guard-probe',v+'.txt'))))";
    const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    for (const file of JSON.parse(result.stdout)) {
      assert.ok(file.toLowerCase().startsWith(fake.tmp.toLowerCase() + path.sep), file);
      assert.ok(fs.existsSync(file), file);
    }
  } finally { fake.done(); }
});

test('the ssam-release/1 schema is valid JSON with the frozen top-level fields', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'schemas', 'ssam-release-1.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema.const, 'ssam-release/1');
  for (const field of ['schema', 'version', 'builtAt', 'sourceCommit', 'distributable', 'runtimes', 'bridges', 'kernelSha256', 'files'])
    assert.ok(schema.required.includes(field), field);
  assert.equal(schema.additionalProperties, false);
});

// W3 (2026-10-10): the O11 discover binds the Service Studio the lane's tools use, and every CLI process of the discover
// runs with it. Before, laneSources('o11') defaulted to the lane's old copy (Service Studio 11 - Anvil 4516, 11.55.87)
// while the suite stamped its results with the installed Studio (11.55.91), so every proof read as historical. Order: the
// selected connection's Studio > ANVIL_STUDIO_DIR > the registry's installation > %ProgramFiles% > the old copy. The
// stamps are compared as before; only the folder they are compared against is the one the CLI binds.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneSources, o11StudioDir, studioIdentity } from '../discovery.mjs';

const studio = dir => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'ServiceStudio.Framework.dll'), 'x'); return dir; };
function machine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-studio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), programFiles = path.join(root, 'pf'), kernel = path.join(root, 'kernel');
  fs.mkdirSync(kernel, { recursive: true }); // the cwd of the CLI processes
  const lane = laneSources('o11', { kernel, env: { USERPROFILE: home, ProgramFiles: programFiles }, studio: { registry: () => null, connection: () => null } }).o11Lane.name;
  const bridge = lane === 'ss5' ? 4536 : 4516;
  return { root, home, programFiles, kernel, lane, copy: path.join(home, 'OutSystems', `Service Studio 11 - Anvil ${bridge}`, 'Service Studio'),
    installed: path.join(programFiles, 'OutSystems', 'Service Studio 11', 'Service Studio'), env: { USERPROFILE: home, ProgramFiles: programFiles } };
}

test('o11 laneSources: the installed Studio before the lane copy, the registry before Program Files, the variable before both, the connection first', t => {
  const m = machine(t);
  studio(m.copy);
  // Only the old copy: it is still found (last resort), as before.
  let s = laneSources('o11', { kernel: m.kernel, env: m.env, studio: { registry: () => null } });
  assert.equal(s.studioDir, m.copy); assert.equal(s.studioSource, 'lane-copy');
  // The installed Studio in Program Files wins over the copy: the defect (the default was the copy).
  studio(m.installed);
  s = laneSources('o11', { kernel: m.kernel, env: m.env, studio: { registry: () => null } });
  assert.equal(s.studioDir, m.installed); assert.equal(s.studioSource, 'programfiles');
  assert.equal(s.env.ANVIL_STUDIO_DIR, m.installed, 'the CLI processes bind the same Studio');
  assert.equal(s.env.ANVIL_LANE, m.lane);
  // The registry's installation (Uninstall "OutSystems Service Studio 11" InstallLocation + "Service Studio").
  const registered = path.join(m.root, 'reg', 'Service Studio 11');
  studio(path.join(registered, 'Service Studio'));
  s = laneSources('o11', { kernel: m.kernel, env: m.env, studio: { registry: () => registered } });
  assert.equal(s.studioDir, path.join(registered, 'Service Studio')); assert.equal(s.studioSource, 'registry');
  // ANVIL_STUDIO_DIR over the registry; a variable naming a folder without the Studio is passed over.
  const chosen = studio(path.join(m.root, 'chosen'));
  s = laneSources('o11', { kernel: m.kernel, env: { ...m.env, ANVIL_STUDIO_DIR: chosen }, studio: { registry: () => registered } });
  assert.equal(s.studioDir, chosen); assert.equal(s.studioSource, 'variable');
  s = laneSources('o11', { kernel: m.kernel, env: { ...m.env, ANVIL_STUDIO_DIR: path.join(m.root, 'nothing') }, studio: { registry: () => registered } });
  assert.equal(s.studioSource, 'registry');
  // The selected connection (the record studio-session.mjs reads, as anvil-cli.mjs laneEnvironment) over everything.
  const connected = studio(path.join(m.root, 'connected'));
  const authority = path.join(m.root, 'authority');
  fs.mkdirSync(path.join(m.kernel, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(m.kernel, '.local', 'connections', m.lane + '.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: m.lane, pid: 4242,
    startedUtc: '2026-10-10T00:00:00Z', studioDir: connected, authorityDir: authority, port: 45999 }));
  s = laneSources('o11', { kernel: m.kernel, env: { ...m.env, ANVIL_STUDIO_DIR: chosen }, studio: { registry: () => registered } });
  assert.equal(s.studioDir, connected); assert.equal(s.studioSource, 'connection');
  assert.equal(s.env.ANVIL_STUDIO_DIR, connected); assert.equal(s.env.ANVIL_AUTHORITY_DIR, authority);
  // An invalid record is passed over (the tools that need it report it), never thrown here.
  fs.writeFileSync(path.join(m.kernel, '.local', 'connections', m.lane + '.json'), '{"ok":true}');
  assert.equal(laneSources('o11', { kernel: m.kernel, env: { ...m.env, ANVIL_STUDIO_DIR: chosen }, studio: { registry: () => registered } }).studioSource, 'variable');
  assert.deepEqual(o11StudioDir({ kernel: m.kernel, laneName: m.lane, env: m.env, registry: () => null, exists: () => false }).source, 'none');
});

test('the CLI processes of the discover run with the lane Studio (verify-catalog reads ANVIL_STUDIO_DIR of sources.env)', async t => {
  const m = machine(t);
  studio(m.copy); studio(m.installed);
  const sources = laneSources('o11', { kernel: m.kernel, env: { ...process.env, ...m.env, ANVIL_STUDIO_DIR: '' }, studio: { registry: () => null } });
  assert.equal(sources.studioDir, m.installed);
  // A stand-in for the lane CLI: answers verify-catalog with the Studio folder it was started with.
  const fake = path.join(m.root, 'fake-cli.mjs');
  fs.writeFileSync(fake, "process.stdout.write(JSON.stringify({ ok: true, data: { platform: 'o11', ideVersion: process.env.ANVIL_STUDIO_DIR + '|' + process.argv[2], count: 1 } }));");
  const identity = await studioIdentity({ ...sources, cli: fake, dotnet: process.execPath });
  assert.equal(identity.error, undefined, identity.error);
  assert.equal(identity.ideVersion, m.installed + '|verify-catalog', 'the CLI bound the Studio the index hashes');
  assert.equal(identity.dir, m.installed);
  // A copy of the sources with another Studio folder binds that folder, never the one of the environment it copied.
  const other = await studioIdentity({ ...sources, studioDir: m.copy, cli: fake, dotnet: process.execPath });
  assert.equal(other.ideVersion, m.copy + '|verify-catalog'); assert.equal(other.dir, m.copy);
});

test('odc laneSources: the ODC Studio folder travels to the CLI processes too', () => {
  const dir = path.join(os.tmpdir(), 'odc-studio-x');
  const s = laneSources('odc', { env: { ANVIL_ODC_STUDIO_DIR: dir } });
  assert.equal(s.studioDir, dir); assert.equal(s.env.ANVIL_ODC_STUDIO_DIR, dir);
  const d = laneSources('odc', { env: { ProgramFiles: 'P:\\PF' } });
  assert.equal(d.studioDir, path.join('P:\\PF', 'OutSystems', 'ODC Studio', 'ODC Studio')); assert.equal(d.env.ANVIL_ODC_STUDIO_DIR, d.studioDir);
});

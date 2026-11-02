// C-49 (F-FT-31, 27/10/2026): the Service Studio updated itself to 11.55.94 on net10.0 and the connector build failed with 1700
// compiler errors; ssam_connect and ssam_doctor said only "Connector build failed". Now the failure names the update (from the
// last good build to the Studio installed now, with its runtime), the first compiler errors and the action, and the doctor
// keeps saying it until a build succeeds. Fake Studio folders and a fake dotnet; no process, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peFileVersion, studioRuntime, firstBuildErrors, connectorFailure, connectorHealth, lastGoodBuild, lastBuildFailure, recordGoodBuild,
  STUDIO_UPDATED, CONNECTOR_BUILD_FAILED } from '../studio-runtime.mjs';
import { build, connectAll } from '../studio-connect.mjs';
import { doctorO11 } from '../ssam.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c49-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// A PE with its VS_FIXEDFILEINFO: signature 0xFEEF04BD, dwStrucVersion, dwFileVersionMS, dwFileVersionLS.
function pe(version) {
  const [a, b, c, d] = version.split('.').map(Number);
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32LE(0xfeef04bd, 0); fixed.writeUInt32LE(0x00010000, 4); fixed.writeUInt32LE(((a << 16) | b) >>> 0, 8); fixed.writeUInt32LE(((c << 16) | d) >>> 0, 12);
  return Buffer.concat([Buffer.from('MZ' + '\0'.repeat(200)), fixed, Buffer.alloc(64)]);
}
function studio(dir, version, tfm) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ServiceStudio.exe'), pe(version));
  fs.writeFileSync(path.join(dir, 'ServiceStudio.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm,
    includedFrameworks: [{ name: 'Microsoft.NETCore.App', version: tfm === 'net10.0' ? '10.0.13' : '8.0.20' }] } }));
  return dir;
}
// The first lines of the bridge build log of 27/10 09:43 (kernel/.local/runtime-connect/4d9e7ea4.../bridge-build.log).
const NET10_LOG = [
  'C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\.local\\runtime-connect\\4d9e7ea4896445e084cd9e25102aeda4\\bridge-artifacts\\obj\\Anvil.Authoring\\release\\.NETCoreApp,Version=v8.0.AssemblyAttributes.cs(4,46): error CS0234: O nome de tipo ou namespace "TargetFrameworkAttributeAttribute" não existe no namespace "System.Runtime.Versioning" (você está sem uma referência de assembly?) [C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\src\\Anvil.Authoring\\Anvil.Authoring.csproj]',
  'C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\.local\\runtime-connect\\4d9e7ea4896445e084cd9e25102aeda4\\bridge-artifacts\\obj\\Anvil.Authoring\\release\\.NETCoreApp,Version=v8.0.AssemblyAttributes.cs(4,46): error CS0234: O nome de tipo ou namespace "TargetFrameworkAttributeAttribute" não existe no namespace "System.Runtime.Versioning" (você está sem uma referência de assembly?) [C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\src\\Anvil.Authoring\\Anvil.Authoring.csproj]',
  'C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\src\\Anvil.Core\\Kernel\\ModelHost.cs(12,7): error CS0518: O tipo predefinido "System.Object" não está definido ou importado [C:\\Users\\andre\\SSAM-Hybrid-proto\\kernel\\src\\Anvil.Core\\Anvil.Core.csproj]',
  '    0 Aviso(s)', '    1700 Erro(s)'].join('\r\n');
const failing = text => async () => { throw Object.assign(new Error('Command failed: dotnet build'), { stdout: text, stderr: '' }); };
const succeeding = async () => ({ stdout: 'Build succeeded.', stderr: '' });

test('C-49 the Studio installed is read from its files: FileVersion of ServiceStudio.exe and the runtimeconfig tfm', t => {
  const dir = studio(path.join(tmp(t), 'Service Studio'), '11.55.94.65328', 'net10.0');
  assert.equal(peFileVersion(path.join(dir, 'ServiceStudio.exe')), '11.55.94.65328');
  assert.deepEqual(studioRuntime(dir), { dir, version: '11.55.94.65328', tfm: 'net10.0', frameworks: { 'Microsoft.NETCore.App': '10.0.13' } });
  assert.equal(studioRuntime(path.join(dir, 'missing')), null);
  assert.deepEqual(firstBuildErrors(NET10_LOG).map(e => e.code), ['CS0234', 'CS0518'], 'distinct errors, first ones');
  assert.equal(firstBuildErrors(NET10_LOG)[1].at, 'ModelHost.cs(12,7)');
});

test('C-49 a build that fails after the Studio changed says STUDIO_UPDATED from, to and runtime, with the errors and the action; the doctor keeps it', async t => {
  const root = tmp(t);
  const old = studio(path.join(root, 'old', 'Service Studio'), '11.55.91.64000', 'net8.0');
  const now = studio(path.join(root, 'new', 'Service Studio'), '11.55.94.65328', 'net10.0');
  const out = path.join(root, '.local', 'runtime-connect', 'attempt', 'bridge');
  // The bridge built for 11.55.91 is the last good build.
  await build('Anvil.Bridge.csproj', out, [], { root, studioDir: old, what: 'bridge', run: succeeding });
  assert.equal(lastGoodBuild(root).studio.version, '11.55.91.64000');
  // The Studio updated itself; the next bridge build fails.
  const error = await build('Anvil.Bridge.csproj', out, [], { root, studioDir: now, what: 'bridge', run: failing(NET10_LOG) }).then(() => null, e => e);
  assert.ok(error, 'the build failed');
  assert.equal(error.code, STUDIO_UPDATED);
  assert.match(error.message, /^Service Studio was updated from 11\.55\.91\.64000 \(net8\.0\) to 11\.55\.94\.65328 \(net10\.0\)/);
  assert.match(error.message, /CS0234/);
  assert.deepEqual(error.connector.studio, { from: { version: '11.55.91.64000', tfm: 'net8.0' }, to: { version: '11.55.94.65328', tfm: 'net10.0' }, runtime: 'net10.0' });
  assert.equal(error.connector.errorCount, 3);
  assert.match(error.connector.action, /Microsoft\.NETCore\.App\.Ref\\10\.x/);
  assert.match(error.connector.action, /ssam_connect/);
  assert.ok(fs.existsSync(error.connector.log));
  assert.equal(lastBuildFailure(root).code, STUDIO_UPDATED);

  // ssam_doctor: the Studio changed since the last good build, and the failure stands, with its action.
  const health = connectorHealth(root, { runtime: studioRuntime(now) });
  assert.equal(health.studioChanged, true);
  assert.equal(health.lastFailure.code, STUDIO_UPDATED);
  const report = await doctorO11({ processes: async () => [{ pid: 7, path: path.join(now, 'ServiceStudio.exe'), window: true }], facts: async () => ({ bridge: 4516 }),
    probe: async () => ({ connected: false, occupied: false }), record: () => null, cliBuilt: true, reservations: { list: () => [] }, connector: () => health });
  assert.equal(report.ok, false);
  assert.equal(report.code, STUDIO_UPDATED);
  assert.match(report.hint.why, /updated from 11\.55\.91\.64000/);
  assert.equal(report.connector.lastFailure.errors[0].code, 'CS0234');

  // A build that succeeds again (the integrator updated SSAM) is the new last good build, and the failure is over.
  await build('Anvil.Bridge.csproj', out, [], { root, studioDir: now, what: 'bridge', run: succeeding });
  assert.equal(lastGoodBuild(root).studio.tfm, 'net10.0');
  assert.equal(lastBuildFailure(root), null);
  assert.equal(connectorHealth(root, { runtime: studioRuntime(now) }), null);
});

test('C-49 without a good build recorded: the connection record names the Studio known to work; with none, CONNECTOR_BUILD_FAILED with the errors', t => {
  const runtime = { dir: 'x', version: '11.55.94.65328', tfm: 'net10.0' };
  const fromRecord = connectorFailure({ what: 'bridge', log: 'l', logText: NET10_LOG, runtime, record: { studioVersion: '11.55.91.64000' } });
  assert.equal(fromRecord.code, STUDIO_UPDATED);
  assert.deepEqual(fromRecord.studio.from, { version: '11.55.91.64000', tfm: null });
  const unknown = connectorFailure({ what: 'bridge', log: 'l', logText: NET10_LOG, runtime });
  assert.equal(unknown.code, CONNECTOR_BUILD_FAILED);
  assert.match(unknown.error, /^Connector build failed \(bridge, 3 compiler errors\) for Service Studio 11\.55\.94\.65328 \(net10\.0\); Studio unchanged\. First error: CS0234/);
  // The same Studio (another build number of the same version) is no update.
  const same = connectorFailure({ what: 'hook', log: 'l', logText: 'x: error CS1002: ; expected', runtime, last: { studio: { version: '11.55.94.65000', tfm: 'net10.0' } } });
  assert.equal(same.code, CONNECTOR_BUILD_FAILED);
});

test('C-49 ssam_connect answers the code and the diagnosis of the Studio it could not attach', async () => {
  const diagnosis = connectorFailure({ what: 'bridge', log: 'C:\\x\\bridge-build.log', logText: NET10_LOG, runtime: { version: '11.55.94.65328', tfm: 'net10.0' },
    last: { studio: { version: '11.55.91.64000', tfm: 'net8.0' } } });
  const o11 = { processes: async () => [{ pid: 7, window: true }], probe: async () => ({ connected: false }), record: () => null,
    connect: async () => { throw Object.assign(new Error(diagnosis.error + ' ' + diagnosis.action), { code: diagnosis.code, connector: diagnosis }); },
    session: async () => ({ tenant: null, account: null }) };
  const value = await connectAll({ lane: 'o11' }, { served: ['o11'], o11 });
  assert.equal(value.ok, false);
  assert.equal(value.code, STUDIO_UPDATED);
  assert.match(value.error, /updated from 11\.55\.91\.64000 \(net8\.0\) to 11\.55\.94\.65328 \(net10\.0\)/);
  assert.equal(value.connector.errors[0].code, 'CS0234');
  assert.equal(value.next, diagnosis.action);
  assert.equal(value.studios[0].code, STUDIO_UPDATED);
});

test('C-49 recordGoodBuild never fails the connection and keeps what was built for which Studio', t => {
  const root = tmp(t);
  const record = recordGoodBuild(root, { dir: 'd', version: '11.55.94.65328', tfm: 'net10.0' }, { now: new Date('2026-10-27T12:00:00Z') });
  assert.deepEqual(record, { schema: 'ssam-studio-build/1', what: 'bridge', studio: { version: '11.55.94.65328', tfm: 'net10.0', dir: 'd' }, builtAt: '2026-10-27T12:00:00.000Z' });
  assert.equal(recordGoodBuild(null, null), null);
});

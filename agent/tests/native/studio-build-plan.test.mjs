import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STUDIO_WINDOW, studioBuildPlan, coverageMatrix } from '../../scripts/studio-build-plan.mjs';
import { fileURLToPath } from 'node:url';

test('all six releases use their own Studio references and runtime, without implying live validation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-build-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const lane of ['odc', 'o11']) {
    assert.equal(STUDIO_WINDOW[lane].length, 3);
    for (const [i, release] of STUDIO_WINDOW[lane].entries()) {
      const dir = path.join(root, lane, release); fs.mkdirSync(dir, { recursive: true });
      const entry = lane === 'odc' ? 'ODCStudio' : 'ServiceStudio';
      const tfm = ['net10.0', 'net9.0', 'net8.0'][i];
      fs.writeFileSync(path.join(dir, entry + '.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm } }));
      fs.writeFileSync(path.join(dir, entry + '.dll'), 'fixture');
      const plan = studioBuildPlan({ lane, dir, version: release + '.123' }, root, 'v98');
      assert.equal(plan.targetFramework, tfm);
      assert.ok(plan.projects.every(p => p.targetFramework === tfm));
      assert.deepEqual(plan.projects[0].properties, [(lane === 'odc' ? '-p:OdcInstall=' : '-p:SSDir=') + dir]);
      assert.equal(plan.projects.length, lane === 'odc' ? 1 : 2);
    }
  }
  assert.equal(coverageMatrix().length, 6);
  assert.ok(coverageMatrix().every(r => r.build === 'not-tested' && r.live === 'not-tested'));
});

test('unsupported and malformed versions fail before reading or compiling a project', () => {
  for (const [lane, version] of [['odc', '1.7.12.10367'], ['odc', '1.7.31.1'], ['o11', '11.55.91.1']])
    assert.throws(() => studioBuildPlan({ lane, version, dir: 'missing' }, '.', 'v98'), /STUDIO_OUTSIDE_BUILD_WINDOW/);
  assert.throws(() => studioBuildPlan({ lane: 'odc', version: '1.7.30.1-invalid' }, '.', 'v98'), /version/);
});

// agent/r4-v106 (A8): one source, one bridge per runtime. Bridge.csproj names it by TargetFramework, and the plan of each ODC
// Studio carries its own name (v108 for net8, v109 for net10), whatever single name the source pack says.
test('the ODC plan names the bridge of the Studio runtime from Bridge.csproj (agent box and line forms)', async t => {
  const { odcBridgeFor } = await import('../../scripts/studio-build-plan.mjs');
  const box = fs.readFileSync(fileURLToPath(new URL('../../platforms/odc/studio/bridge/Bridge.csproj', import.meta.url)), 'utf8');
  assert.equal(odcBridgeFor(box, 'net8.0'), 'v108');
  assert.equal(odcBridgeFor(box, 'net10.0'), 'v109');
  const line = '<AssemblyName>ODC3.Bridge.v106</AssemblyName><AssemblyName Condition="\'$(TargetFramework)\' == \'net8.0\'">ODC3.Bridge.v107</AssemblyName>';
  assert.equal(odcBridgeFor(line, 'net8.0'), 'v107');
  assert.equal(odcBridgeFor(line, 'net10.0'), 'v106');
  assert.equal(odcBridgeFor('<!-- <AssemblyName>ODC3.Bridge.v1</AssemblyName> -->', 'net8.0'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-build-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'platforms/odc/studio/bridge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'platforms/odc/studio/bridge/Bridge.csproj'), box);
  for (const [release, tfm, expected] of [['1.7.30', 'net10.0', 'v109'], ['1.7.29', 'net8.0', 'v108'], ['1.7.28', 'net8.0', 'v108']]) {
    const dir = path.join(root, 'studios', release); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ODCStudio.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm } }));
    fs.writeFileSync(path.join(dir, 'ODCStudio.dll'), 'fixture');
    const plan = studioBuildPlan({ lane: 'odc', dir, version: release + '.1' }, root, 'v107');
    assert.equal(plan.bridgeVersion, expected, release);
    assert.equal(plan.projects[0].assembly, 'ODC3.Bridge.' + expected);
    assert.equal(plan.projects[0].targetFramework, tfm);
  }
});

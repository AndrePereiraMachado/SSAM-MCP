import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STUDIO_WINDOW, studioBuildPlan, coverageMatrix } from '../../scripts/studio-build-plan.mjs';

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

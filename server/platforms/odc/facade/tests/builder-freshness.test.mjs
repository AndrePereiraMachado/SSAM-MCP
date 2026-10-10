import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builderNeedsBuild } from '../lib.mjs';

test('a changed shared reader cannot silently leave the ODC builder stale', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-builder-freshness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'studio'); fs.mkdirSync(sourceRoot);
  const file = path.join(dir, 'builder.dll');
  const local = path.join(sourceRoot, 'Inspect.cs');
  const shared = path.join(dir, 'ModelReading.cs');
  for (const entry of [file, local, shared]) { fs.writeFileSync(entry, 'fixture'); fs.utimesSync(entry, 10000, 10000); }
  const inputs = { file, sourceRoot, linkedSources: [shared] };
  assert.equal(builderNeedsBuild(inputs), false);
  fs.utimesSync(shared, 20000, 20000);
  assert.equal(builderNeedsBuild(inputs), true);
  fs.utimesSync(file, 30000, 30000);
  assert.equal(builderNeedsBuild(inputs), false);
  assert.equal(builderNeedsBuild({ ...inputs, linkedSources: [path.join(dir, 'missing.cs')] }), true);
});

test('only declared builder inputs trigger a build, including linked files and feature globs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-builder-inputs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir,'features'));
  const project = path.join(dir,'Builder.csproj'), file = path.join(dir,'builder.dll');
  fs.writeFileSync(project,'<Project><Compile Include="Inspect.cs"/><Compile Include="features\\*.cs"/><Compile Include="Shared.cs"/></Project>');
  for(const name of ['Inspect.cs','Shared.cs','features/Feature.cs','Bridge.cs','builder.dll']) fs.writeFileSync(path.join(dir,name),'fixture');
  for(const name of ['Builder.csproj','Inspect.cs','Shared.cs','features/Feature.cs']) fs.utimesSync(path.join(dir,name),10000,10000);
  fs.utimesSync(file,20000,20000);
  const inputs={file,project};
  assert.equal(builderNeedsBuild(inputs),false,'unrelated newer bridge must not rebuild');
  fs.utimesSync(path.join(dir,'features/Feature.cs'),30000,30000);
  assert.equal(builderNeedsBuild(inputs),true);
  fs.utimesSync(file,40000,40000);
  assert.equal(builderNeedsBuild(inputs),false);
  fs.unlinkSync(path.join(dir,'Shared.cs'));
  assert.equal(builderNeedsBuild(inputs),true,'missing linked input must fail closed');
});

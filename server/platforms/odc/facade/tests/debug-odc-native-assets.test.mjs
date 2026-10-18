import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOdcRuntimeEntry, readOdcRuntimeSources, assetHash } from '../debug-odc-native-assets.mjs';
test('runtime binding cannot silently skip the chosen entry to invoke the target', () => {
  const target = { key: 'target', chunk: 'target.js', type: 'CLIENT_ACTION', holder: { name: 'target', local: 'target' } };
  const runtime = { index: { functions: { target: [target] }, views: {}, groups: {}, screens: {} } };
  assert.throws(() => resolveOdcRuntimeEntry({ entry: { key: 'entry', entryKind: 'screen' }, path: [{ key: 'entry' }, { key: 'target' }] }, runtime), /entry_not_executable/);
  const plan = resolveOdcRuntimeEntry({ entry: { key: 'target' }, path: [{ key: 'target' }] }, runtime);
  assert.equal(plan.member.key, 'target'); assert.equal(plan.invocation, 'client-action');
});
test('changed published assets are rejected before runtime evaluation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-assets-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'asset.js'); fs.writeFileSync(file, 'original');
  const runtime = { pins: { 'asset.js': { path: file, sha256: assetHash(Buffer.from('original')) } } };
  assert.equal(readOdcRuntimeSources(runtime)['asset.js'], 'original');
  fs.writeFileSync(file, 'modified'); assert.throws(() => readOdcRuntimeSources(runtime), /source_changed/);
});

test('screen action signature stays callable without a lifecycle link; event inputs cannot be invented', () => {
  const member = { key: 'action', chunk: 'screen.js', holder: { kind: 'method', name: 'action$Action' }, type: 'CLIENT_SCREEN_ACTION',
    controllerFactory: 'controller', varsGroup: 'Action$vars' };
  const runtime = { index: { functions: { action: [member] }, groups: { 'Action$vars': [{ chunk: 'screen.js', attributes: [{ name: 'Amount', attrName: 'amountInLocal', dataType: 'Integer' }] }] },
    screens: { 'Flow.Screen': 'screen.js' }, views: { screen: [{ key: 'screen', chunk: 'screen.js', displayName: 'Flow.Screen', controllerFactory: 'controller', modelFactory: 'model' }] } } };
  const prepared = { entry: { key: 'action' }, path: [{ key: 'action' }] };
  const plan = resolveOdcRuntimeEntry(prepared, runtime);
  assert.equal(plan.invocation, 'screen-action'); assert.equal(plan.inputs[0].name, 'Amount');
  member.lifecycleHandler = ['onReadyEventHandler'];
  assert.throws(() => resolveOdcRuntimeEntry(prepared, runtime), /lifecycle_inputs_not_controllable/);
});

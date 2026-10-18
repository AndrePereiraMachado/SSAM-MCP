import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOdcPublishedDefinition } from '../debug-odc-native-host.mjs';
const binding = { module: 'EscalaViva', moduleKey: 'KwiD3Tgt3kOKgCu8elGE4g', revision: 8 };
const definition = { applicationName: 'Escala Viva', applicationKey: 'dd83082b-2d38-43de-8a80-2bbc7a5184e2',
  homeModuleName: 'EscalaViva', homeModuleKey: 'dd83082b-2d38-43de-8a80-2bbc7a5184e2', appVersion: '8' };
test('native published GUIDs and technical route accept a distinct display label', () => {
  assert.doesNotThrow(() => validateOdcPublishedDefinition(definition, binding));
  assert.doesNotThrow(() => validateOdcPublishedDefinition({ ...definition, applicationName: 'Another display label' }, binding));
});
test('equal display names cannot mask another app, module, route or published revision', () => {
  for (const change of [{ applicationKey: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, { homeModuleKey: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { homeModuleName: 'OtherRoute' }, { appVersion: '9' }])
    assert.throws(() => validateOdcPublishedDefinition({ ...definition, ...change }, binding), /published_model_mismatch/);
});

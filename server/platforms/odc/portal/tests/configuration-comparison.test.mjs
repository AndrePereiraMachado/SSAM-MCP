import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareApplicationConfigurations as compare } from '../runtime/configuration-comparison.mjs';

const config = (key = 'Schedule') => ({ key, isSecret: false, dataType: 'Text', value: '', deployedValue: '',
  valueOrigin: 'ApplicationLevelDefault', deployedValueOrigin: 'ApplicationLevelDefault' });
const fixture = () => ({ revisionBaseline: 7, revisionDeployed: 7, settings: [config('Setting')],
  systemConfigurations: [config('System')], timers: [{ key: 'timer', configs: [config()] }],
  integrations: [{ key: 'rest', configs: [config('Endpoint')] }], libraries: [] });

test('equal readable values and origins remain an observation, not apply approval', () => {
  const input = fixture(), before = structuredClone(input), result = compare(input);
  assert.equal(result.state, 'equal-observed-values');
  assert.deepEqual(result.counts, { equal: 4, different: 0, unknown: 0 });
  assert.equal(result.applySafetyProven, false);
  assert.equal(result.scope, 'single-response');
  assert.deepEqual(input, before);
});

test('app-wide comparison finds non-timer and origin-only changes without leaking values', () => {
  const input = fixture();
  input.settings[0].value = 'private-business-value';
  input.systemConfigurations[0].valueOrigin = 'ApplicationLevelOverride';
  input.integrations[0].configs[0].value = 'https://internal.example.test/api';
  const result = compare(input);
  assert.equal(result.state, 'differences-observed');
  assert.deepEqual(result.issues.map(x => [x.path, x.reason]), [
    ['/settings/0', 'value-changed'], ['/systemConfigurations/0', 'origin-changed'],
    ['/integrations/0/configs/0', 'value-changed']]);
  assert.doesNotMatch(JSON.stringify(result), /private-business|internal.example/);
});

test('missing collections, duplicate identity, unreadable origins and revision drift cannot look equal', async t => {
  for (const [name, change, expected] of [
    ['missing timers', x => { delete x.timers; }, 'unproven'],
    ['null integrations', x => { x.integrations = null; }, 'unproven'],
    ['missing libraries', x => { delete x.libraries; }, 'unproven'],
    ['invalid system configs', x => { x.systemConfigurations = {}; }, 'unproven'],
    ['duplicate configs', x => { x.settings.push({ ...x.settings[0], key: 'SETTING' }); }, 'unproven'],
    ['duplicate timers', x => { x.timers.push(structuredClone(x.timers[0])); }, 'unproven'],
    ['masked values', x => { x.settings[0].value = x.settings[0].deployedValue = '[REDACTED]'; }, 'unproven'],
    ['missing origin', x => { delete x.settings[0].valueOrigin; }, 'unproven'],
    ['unknown origin', x => { x.settings[0].valueOrigin = 'FutureOrigin'; }, 'unproven'],
    ['new app configuration category', x => { x.futureConfigurations = []; }, 'unproven'],
    ['new timer configuration field', x => { x.timers[0].futureConfig = 'changed'; }, 'unproven'],
    ['new config field', x => { x.settings[0].pendingValue = 'changed'; }, 'unproven'],
    ['null value', x => { x.settings[0].value = x.settings[0].deployedValue = null; }, 'unproven'],
    ['binary URLs', x => { x.settings[0].dataType = 'BinaryUrl'; }, 'unproven'],
    ['unknown secret flag', x => { delete x.settings[0].isSecret; }, 'unproven'],
    ['missing revision', x => { delete x.revisionDeployed; }, 'unproven'],
    ['revision drift', x => { x.revisionBaseline++; }, 'differences-observed'],
  ]) await t.test(name, () => { const input = fixture(); change(input); assert.equal(compare(input).state, expected); });
  assert.equal(compare(null).state, 'unproven');
});

test('equal secret masks never prove equality, and changed secret metadata is preserved', () => {
  for (const changed of [false, true, null]) {
    const input = fixture();
    Object.assign(input.settings[0], { isSecret: true, valueSetAfterDeploy: changed,
      value: 'secret-that-must-not-be-returned', deployedValue: 'secret-that-must-not-be-returned' });
    const result = compare(input);
    assert.equal(result.state, changed ? 'differences-observed' : 'unproven');
    assert.ok(result.counts.unknown > 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-that/);
    assert.equal(result.issues.some(x => x.reason === 'secret-set-after-deploy'), changed === true);
  }
});

test('library settings, system configurations and integrations are traversed without claiming deployed identity', () => {
  const input = fixture();
  input.libraries = [{ key: 'library', revision: 4, revisionBaseline: 4,
    settings: [config('Setting')], systemConfigurations: [config('System')],
    integrations: [{ key: 'rest', configs: [config('Endpoint')] }] }];
  for (const item of [input.libraries[0].settings[0], input.libraries[0].systemConfigurations[0],
    input.libraries[0].integrations[0].configs[0]]) item.value = 'changed';
  const result = compare(input);
  assert.equal(result.counts.different, 3);
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.applySafetyProven, false);
});

test('bounded diagnostics keep the total unresolved count and signal truncation', () => {
  const input = fixture(); input.settings = Array.from({ length: 250 }, (_, i) => ({ ...config(String(i)), value: 'changed' }));
  const result = compare(input);
  assert.equal(result.counts.different, 250);
  assert.equal(result.issues.length, 200);
  assert.equal(result.issuesTruncated, true);
});

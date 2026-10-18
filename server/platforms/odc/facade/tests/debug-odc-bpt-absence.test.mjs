import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeBackground, ODC_BPT_ABSENCE, odcBptAbsence } from '../debug-native-background.mjs';

const key = c => c.repeat(22), stage = '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const BPT = ['Process', 'ProcessFlow', 'AutomaticActivity', 'AutomaticActivityNode', 'HumanActivityNode', 'ProcessActivity'];
const EVIDENCE = ['kernel/docs/NAO-DA.md:31-33', 'kernel/docs/NAO-DA.md:371-390', 'kernel/docs/NAO-DA.md:1043-1061',
  'platforms/odc/facade/discovery-capabilities.json:742', 'platforms/odc/docs/model-api/OutSystems.Model.V1.md:8031'];
function plan(kind, lane = 'odc', extra = {}) {
  const binding = { lane, runtimeUrl: 'https://dev.example.test/Store/', module: 'Store', moduleKey: key('a'), revision: 42, sourceSha256: 'e'.repeat(64),
    ...(lane === 'odc' ? { tenant: 'wrightflood.outsystems.dev', environmentKey: stage } : {}) };
  const model = { schema: 'ssam-reading/1', model: 'Store', sourceSha256: binding.sourceSha256,
    tree: { key: key('b'), kind, name: 'Nightly', children: [], childrenOmitted: 0, childrenTotal: 0,
      propertyReferences: { Action: { key: key('c'), kind: 'ServerAction', path: 'Store/Nightly' } }, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] } };
  return prepareNativeBackground({ binding, model, entryKey: key('b'), moduleId: 7, ...extra });
}

test('ODC Process-like kinds are refused as not in the ODC product, pointing to ODC Workflow (P38)', () => {
  for (const kind of BPT) {
    const p = plan(kind);
    assert.equal(p.executable, false, kind); assert.equal(p.error, 'debug_native_background_odc_bpt_not_in_product', kind);
    assert.notEqual(p.error, 'debug_native_background_odc_workflow_requires_original_event_or_instance');
    assert.equal(p.see, 'P38 ODC Workflow'); assert.deepEqual(p.evidence, EVIDENCE); assert.equal(p.kind, kind);
    assert.equal(p.evidencePath, '.local/debugger/bpt/odc-absence.json'); assert.equal(p.evidenceSha256, null);
    assert.equal(p.applicationUserContext, false); assert.equal(p.trigger, undefined); assert.equal(p.actionKey, undefined);
  }
  // A non-BPT, non-Timer ODC kind keeps the Workflow refusal.
  assert.equal(plan('ServerAction').error, 'debug_native_background_odc_workflow_requires_original_event_or_instance');
});

test('ODC Timer path and O11 paths are unchanged', () => {
  const timer = plan('Timer'); assert.equal(timer.executable, true); assert.equal(timer.trigger, 'odc-portal-timer-wake');
  assert.equal(timer.environmentKey, stage); assert.equal(timer.actionKey, key('c')); assert.equal(timer.error, undefined); assert.equal(timer.see, undefined);
  const o11 = plan('Timer', 'o11'); assert.equal(o11.trigger, 'o11-service-center-timer-run'); assert.equal(o11.moduleId, '7');
  for (const kind of ['Process', 'ProcessFlow', 'AutomaticActivity', 'ProcessActivity']) {
    const p = plan(kind, 'o11'); assert.equal(p.error, 'debug_native_background_bpt_requires_original_launch_or_existing_instance'); assert.equal(p.see, undefined);
  }
  assert.throws(() => plan('AutomaticActivityNode', 'o11'), /timer_binding_invalid/);
});

test('ODC_BPT_ABSENCE carries the evidence path, a null hash until the live read, and is never executable', () => {
  assert.equal(ODC_BPT_ABSENCE.evidencePath, '.local/debugger/bpt/odc-absence.json'); assert.equal(ODC_BPT_ABSENCE.evidenceSha256, null);
  assert.deepEqual(ODC_BPT_ABSENCE.evidence, EVIDENCE); assert.match(ODC_BPT_ABSENCE.claim, /Workflow/); assert.equal(ODC_BPT_ABSENCE.executable, false);
  assert.ok(Object.isFrozen(ODC_BPT_ABSENCE)); assert.ok(Object.isFrozen(ODC_BPT_ABSENCE.evidence));
  const sha = 'f'.repeat(64);
  for (const value of [undefined, null, '', 'nope', sha.toUpperCase(), sha, { executable: true }]) {
    const d = odcBptAbsence(value); assert.equal(d.executable, false); assert.equal(d.evidencePath, ODC_BPT_ABSENCE.evidencePath);
  }
  assert.equal(odcBptAbsence(sha).evidenceSha256, sha); assert.equal(odcBptAbsence(sha.toUpperCase()).evidenceSha256, sha);
  assert.equal(odcBptAbsence('nope').evidenceSha256, null); assert.equal(odcBptAbsence({ executable: true }).evidenceSha256, null);
  // A live-read hash is reported, never upgrades the refusal.
  const p = plan('Process', 'odc', { bptAbsenceEvidenceSha256: sha });
  assert.equal(p.executable, false); assert.equal(p.error, 'debug_native_background_odc_bpt_not_in_product'); assert.equal(p.evidenceSha256, sha);
  assert.equal(ODC_BPT_ABSENCE.evidenceSha256, null);
});

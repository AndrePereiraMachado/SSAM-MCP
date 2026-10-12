import test from 'node:test';
import assert from 'node:assert/strict';
import { serverCapabilities, serverCapabilityEvidence } from '../debug-server-capabilities.mjs';

test('O11 advertises qualified pause, steps, frames and cross-module step-into; service step-into is unsupported', () => {
  assert.deepEqual(serverCapabilities('o11'), {
    manualPause: { supported: true, mode: 'native-suspend-all-threads', scope: 'native-debug-session-threads', immediateSuspension: false, liveQualified: true },
    steps: { supported: true, liveQualified: true },
    frames: { supported: true, liveQualified: true },
    crossModuleStepInto: { supported: true, liveQualified: true },
    serviceStepInto: { supported: false, liveQualified: false, reason: 'native_service_step_into_not_supported' },
  });
});

test('ODC manual pause stays unqualified until evidence flips it; O11 is never downgraded by flags', () => {
  const odc = serverCapabilities('odc');
  assert.equal(odc.manualPause.supported, true); assert.equal(odc.manualPause.liveQualified, false);
  assert.equal(odc.manualPause.mode, 'native-suspend-all-threads');
  assert.equal(odc.steps.liveQualified, true); assert.equal(odc.frames.liveQualified, true);
  assert.equal(odc.crossModuleStepInto.liveQualified, false);
  assert.equal(odc.serviceStepInto.supported, false); assert.equal(odc.serviceStepInto.liveQualified, false);
  assert.equal(serverCapabilities('odc', { odcManualPause: true }).manualPause.liveQualified, true);
  assert.equal(serverCapabilities('odc', { odcManualPause: true }).crossModuleStepInto.liveQualified, false);
  assert.equal(serverCapabilities('odc', { odcCrossModuleStepInto: true }).crossModuleStepInto.liveQualified, true);
  assert.equal(serverCapabilities('o11', { odcManualPause: false }).manualPause.liveQualified, true);
  assert.deepEqual(serverCapabilityEvidence, { odcManualPause: false, odcCrossModuleStepInto: false });
  assert.deepEqual(serverCapabilities('odc', serverCapabilityEvidence), odc);
});

test('evidence flags are strict and results are fresh; a pause acknowledgement cannot change them', () => {
  for (const flags of [{ odcManualPause: 'yes' }, { o11ServiceStepInto: true }, [], null])
    assert.throws(() => serverCapabilities('odc', flags), /debug_server_capabilities_evidence_invalid/);
  assert.throws(() => serverCapabilities('cloud'), /debug_server_capabilities_lane_invalid/);
  const before = serverCapabilities('odc');
  before.manualPause.liveQualified = true; // e.g. a caller recording a pause acknowledgement
  assert.equal(serverCapabilities('odc').manualPause.liveQualified, false);
  assert.ok(Object.isFrozen(serverCapabilityEvidence));
});

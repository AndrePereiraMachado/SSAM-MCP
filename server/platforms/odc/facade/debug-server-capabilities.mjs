// Server debugger capabilities for ssam_debug_server status, shaped like the
// client capabilities.manualPause. They depend only on the lane and on live
// evidence flags; a pause acknowledgement or a local test never changes them.
const fail = code => { throw new Error('debug_server_capabilities_' + code); };
// Flip a flag only after the corresponding live proof passed (MCP and CLI).
export const serverCapabilityEvidence = Object.freeze({ odcManualPause: false, odcCrossModuleStepInto: false });
export function serverCapabilities(lane, evidenceFlags = serverCapabilityEvidence) {
  if (!['o11', 'odc'].includes(lane)) fail('lane_invalid');
  if (!evidenceFlags || typeof evidenceFlags !== 'object' || Array.isArray(evidenceFlags) ||
      Object.entries(evidenceFlags).some(([k, v]) => !Object.hasOwn(serverCapabilityEvidence, k) || typeof v !== 'boolean')) fail('evidence_invalid');
  const o11 = lane === 'o11';
  return {
    // Native SuspendAllThreads for this debug session; acknowledgment is not an observed stop.
    manualPause: { supported: true, mode: 'native-suspend-all-threads', scope: 'native-debug-session-threads', immediateSuspension: false,
      liveQualified: o11 || evidenceFlags.odcManualPause === true },
    steps: { supported: true, liveQualified: true },
    frames: { supported: true, liveQualified: true },
    crossModuleStepInto: { supported: true, liveQualified: o11 || evidenceFlags.odcCrossModuleStepInto === true },
    serviceStepInto: o11 ? { supported: false, liveQualified: false, reason: 'native_service_step_into_not_supported' }
      : { supported: false, liveQualified: false, reason: 'native_service_step_into_unqualified' },
  };
}

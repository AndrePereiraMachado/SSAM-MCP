// A background entry uses the scheduler's native execution context. Trigger
// acceptance, observed execution and successful completion are separate facts.
// It is never presented as application-user access validation.
import { createHash } from 'node:crypto';
import { serviceCenterTool } from './service-center/index.mjs';
import { serviceCenterArguments } from './o11-operations.mjs';
import { nativeEndpointBinding } from './debug-native-endpoint.mjs';
import { blockedBinding } from './debug-o11-native-run.mjs';

const fail = code => { throw new Error('debug_native_background_' + code); };
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

// ODC has no BPT in the product: process automation is a Workflow asset edited in the Portal (P38).
// The SDK still carries OutSystems.Model.Processes; that is API surface, not product. The evidence
// file is a read-only live capture (LPX04); its hash stays null until then and never enables execution.
const ODC_BPT_KINDS = ['Process', 'ProcessFlow', 'AutomaticActivity', 'AutomaticActivityNode', 'HumanActivityNode', 'ProcessActivity'];
export const ODC_BPT_ABSENCE = Object.freeze({ claim: 'ODC has no BPT processes; process automation is an ODC Workflow asset edited in the ODC Portal Workflow Editor.',
  evidence: Object.freeze(['kernel/docs/NAO-DA.md:31-33', 'kernel/docs/NAO-DA.md:371-390', 'kernel/docs/NAO-DA.md:1043-1061',
    'platforms/odc/facade/discovery-capabilities.json:742', 'platforms/odc/docs/model-api/OutSystems.Model.V1.md:8031']),
  evidencePath: '.local/debugger/bpt/odc-absence.json', evidenceSha256: null, see: 'P38 ODC Workflow', executable: false });
// A live-read hash is reported as provenance only; executable stays false whatever it is.
export const odcBptAbsence = sha => ({ ...ODC_BPT_ABSENCE, evidence: [...ODC_BPT_ABSENCE.evidence],
  evidenceSha256: typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : null, executable: false });

export function prepareNativeBackground({ binding: value, model, entryKey, moduleId, bptAbsenceEvidenceSha256 }) {
  const binding = nativeEndpointBinding(value);
  if (model?.schema !== 'ssam-reading/1' || model.model !== binding.module || model.sourceSha256?.toLowerCase() !== binding.sourceSha256 || model.tree?.key !== entryKey)
    fail('model_binding_invalid');
  const node = model.tree;
  if (!Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail('model_incomplete');
  const common = { schema: 'ssam-native-background-entry/1', binding, entryKey, name: node.name, kind: node.kind,
    context: 'native-background', applicationUserContext: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false };
  if (binding.lane === 'odc') {
    if (ODC_BPT_KINDS.includes(node.kind)) { const { claim, evidence, evidencePath, evidenceSha256, see } = odcBptAbsence(bptAbsenceEvidenceSha256);
      return { ...common, executable: false, error: 'debug_native_background_odc_bpt_not_in_product', see, claim, evidence, evidencePath, evidenceSha256 }; }
    if (node.kind !== 'Timer') return { ...common, executable: false,
      error: 'debug_native_background_odc_workflow_requires_original_event_or_instance' };
    if (!GUID.test(value.environmentKey ?? '') || !/^[a-z0-9.-]+\.outsystems\.dev$/.test(value.tenant ?? '')) return {
      ...common, executable: false, error: 'debug_native_background_odc_timer_target_binding_required' };
    if (!/^[A-Za-z_]\w*$/.test(node.name ?? '') || !/^[A-Za-z0-9_+]{22}$/.test(node.propertyReferences?.Action?.key ?? '') ||
        node.propertyReferences.Action.kind !== 'ServerAction' || /^Reference:/.test(node.propertyReferences.Action.path ?? '')) fail('timer_binding_invalid');
    return { ...common, executable: true, trigger: 'odc-portal-timer-wake', environmentKey:value.environmentKey,
      portalOrigin:'https://'+value.tenant, actionKey:node.propertyReferences.Action.key, nativeAuthenticationQualified:false,
      requiredAuthorization:'native-background', completionEvidenceRequired:'correlated-native-execution-id',
      nativeRunIdAvailable:false, limitation:'Portal wake schedules background work; function traces do not prove ownership of this wake.' };
  }
  if (['Process', 'ProcessFlow', 'AutomaticActivity', 'ProcessActivity'].includes(node.kind)) return { ...common,
    executable: false, error: 'debug_native_background_bpt_requires_original_launch_or_existing_instance',
    limitation: 'Executing an activity body directly would bypass the native instance, persistence, transaction and retry semantics.' };
  if (node.kind !== 'Timer' || !/^[1-9]\d{0,9}$/.test(String(moduleId ?? '')) || !/^[A-Za-z_]\w*$/.test(node.name ?? '') ||
      !/^[A-Za-z0-9_+]{22}$/.test(node.propertyReferences?.Action?.key ?? '')) fail('timer_binding_invalid');
  return { ...common, executable: true, trigger: 'o11-service-center-timer-run', moduleId: String(moduleId),
    actionKey: node.propertyReferences.Action.key, nativeAuthenticationQualified: false,
    requiredAuthorization: 'native-background', completionEvidenceRequired: 'service-center-request-key-sha256-and-request-bound-thread-end' };
}

// evidence: { entryKey, moduleKey, sourceSha256, threadOutcome (backgroundThreadOutcome),
// instance (observeO11TimerInstance) }. Scheduling, ThreadEnd, correlation and completion stay
// separate fields; a fingerprint is never wake ownership or app-user identity.
export function observeNativeBackground(plan, receipt, evidence) {
  const accepted = receipt?.state === 'accepted' && receipt.executionCompleted === false && receipt.ok === true;
  const result = { accepted, scheduled: accepted, executionObserved: false, newExactTimerRowObserved: false, threadEndObserved: false, requestBoundThreadEnd: false,
    instanceCorrelationProved: false, executionCompleted: false,
    outcome: ['uncertain','sending','accepted-unverified'].includes(receipt?.state) ? 'uncertain' : accepted ? 'scheduled' : 'unconfirmed',
    operationId: receipt?.operationId ?? null, completionEvidence: 'service-center-request-key-sha256-and-request-bound-thread-end',
    applicationUserContext: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false, requestOwnershipProved: false, wakeOwnershipProved: false };
  // A coincident function key, timer name, timestamp, CallContextId or the never-produced
  // nativeExecutionId is not execution correlation.
  if (!evidence || evidence.entryKey !== plan.entryKey || evidence.moduleKey !== plan.binding.moduleKey ||
      evidence.sourceSha256 !== plan.binding.sourceSha256) return result;
  const thread = evidence.threadOutcome, instance = evidence.instance, fingerprint = instance?.matchedFingerprint;
  result.threadEndObserved = thread?.traceVerified === true; result.requestBoundThreadEnd = thread?.requestBound === true;
  // A new exact cyclic-job row is not attributed to this request; executionObserved needs correlation.
  result.newExactTimerRowObserved = instance?.newExactTimerRowObserved === true;
  // A correlated run never upgrades an uncertain or unconfirmed submission.
  if (!accepted || instance?.instanceCorrelationProved !== true || !/^[a-f0-9]{64}$/.test(fingerprint ?? '') ||
      thread?.requestFingerprintConsistent !== true || !thread.fingerprints?.includes(fingerprint)) return result;
  Object.assign(result, { instanceCorrelationProved: true, executionObserved: true, requestKeySha256: instance.requestKeySha256 ?? null, matchedFingerprint: fingerprint });
  if (instance.outcome === 'failed' && instance.errorBound === true)
    Object.assign(result, { executionCompleted: true, outcome: 'failed', retryScheduled: instance.retryScheduled ?? null, retriesExhausted: instance.retriesExhausted ?? null });
  else if (instance.outcome === 'completed' && instance.errorBound === false && thread.endedFingerprints?.includes(fingerprint))
    Object.assign(result, { executionCompleted: true, outcome: 'completed' });
  return result;
}

const currentServiceCenter = (_lane, _verb, args) => serviceCenterTool(args);
export async function nativeBackgroundServiceCenter(input, runLane = currentServiceCenter) {
  const reply = await runLane('o11', 'service-center', serviceCenterArguments(input, input.action === 'timer-run'));
  const result = reply?.result;
  if (reply?.lane !== 'o11' || reply.verb !== 'service-center' || !result || typeof result !== 'object' || Array.isArray(result))
    fail('native_service_center_response_invalid');
  // lanes.run wraps the native JSON. Keep uncertain write receipts intact;
  // only a failure without an operation receipt is a transport/auth refusal.
  if (reply.ok !== true && !result.operationId) {
    if (typeof result.error === 'string' && result.error.includes('requires OutSystems ID SSO'))
      fail('native_service_center_sso_unqualified');
    fail('native_service_center_failed');
  }
  return result;
}

export function createNativeBackgroundAdapter({ serviceCenter = nativeBackgroundServiceCenter } = {}) {
  return {
    // Read-only form preparation. SSO/AJAX variants missing from the existing
    // native Service Center adapter remain explicit refusals.
    async prepare(plan) {
      if (!plan?.executable || plan.trigger !== 'o11-service-center-timer-run') fail('entry_unavailable');
      const host = new URL(plan.binding.runtimeUrl).hostname;
      const result = await serviceCenter({ action: 'timer-run', host, moduleId: plan.moduleId, name: plan.name });
      if (result.host !== host || result.action !== 'timer-run' || result.moduleId !== plan.moduleId || result.name !== plan.name || result.execute !== false)
        fail('native_preparation_unconfirmed');
      return { ...plan, nativePreparation: { host, action: result.action, moduleId: result.moduleId, name: result.name,
        target: result.target, control: result.control }, nativeAuthenticationQualified: true };
    },
    async run(plan, { root, operationId, context, authorizationWords, inputs = {} }) {
      if (!plan?.executable || !plan.nativeAuthenticationQualified || plan.trigger !== 'o11-service-center-timer-run') fail('entry_unprepared');
      if (context !== 'native-background' || typeof authorizationWords !== 'string' || !authorizationWords.trim() || !GUID.test(operationId ?? '')) fail('explicit_background_authorization_required');
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).length) fail('timer_has_no_direct_inputs');
      const host = new URL(plan.binding.runtimeUrl).hostname;
      if (blockedBinding(root, host, plan.binding.moduleKey)) fail('binding_blocked');
      // The existing native adapter persists authorization + sending BEFORE POST
      // and excludes uncertain targets. It owns replay prevention across runs.
      const receipt = await serviceCenter({ action: 'timer-run', host, moduleId: plan.moduleId, name: plan.name,
        execute: true, words: authorizationWords, operationId });
      if (receipt.operationId !== operationId || receipt.identity?.host !== host || receipt.identity?.moduleId !== plan.moduleId ||
          receipt.identity?.name !== plan.name || receipt.identity?.action !== 'timer-run') fail('trigger_receipt_mismatch');
      return { schema: 'ssam-native-background-run/1', binding: plan.binding, entryKey: plan.entryKey,
        authorizationWordsSha256: hash(authorizationWords), receipt,
        ...observeNativeBackground(plan, receipt), ok: false,
        limitation: 'A scheduler acceptance does not prove that this timer ran or completed. Native background access is separate from app-user access.' };
    },
    // Read-only: the receipt plus caller-supplied correlation evidence; never re-triggers.
    async reconcile(plan, operationId, evidence) {
      if (!GUID.test(operationId ?? '')) fail('operation_invalid');
      const receipt = await serviceCenter({ action: 'receipt', operationId });
      if (receipt.operationId !== operationId || receipt.identity?.host !== new URL(plan.binding.runtimeUrl).hostname ||
          receipt.identity?.moduleId !== plan.moduleId || receipt.identity?.name !== plan.name || receipt.identity?.action !== 'timer-run') fail('trigger_receipt_mismatch');
      const observation = observeNativeBackground(plan, receipt, evidence);
      return { ...observation, ok: observation.outcome === 'completed', receipt, replayed: false };
    },
  };
}

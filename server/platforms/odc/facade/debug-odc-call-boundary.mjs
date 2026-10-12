// Static closure evidence never establishes a producer frame, app identity or
// role propagation. A service app can be deployed independently of its signature.
// An ExternalLibrary (C#) action has no flow nodes or breakpoint targets in the
// debugger model: it is external logic, never a producer target.
const KEY = /^[A-Za-z0-9_+]{22}$/, HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error('debug_odc_external_logic_' + code); };
export function describeOdcCallBoundaries(calls = [], target = {}) {
  const boundaries = calls.filter(call => call.external === true).map(call => {
    const ref = call.reference, producer = call.producer;
    const revision = typeof ref?.revision === 'string' && /^[1-9][0-9]{0,15}$/.test(ref.revision) ? Number(ref.revision) : null;
    const externalLogic = ref?.moduleType === 'ExternalLibrary';
    const library = ref?.moduleType === 'ReactiveLibrary';
    const service = call.actionKind === 'ServiceActionSignature' && !library && !externalLogic;
    const revisionPinned = Number.isSafeInteger(revision) || service && (ref?.revision == null || ref.revision === '');
    const importedIdentityPinned = KEY.test(call.actionKey ?? '') && KEY.test(ref?.moduleKey ?? '') && KEY.test(ref?.originalActionKey ?? '') &&
      HASH.test(ref?.consumerSourceSha256 ?? '') && (library || service) && revisionPinned;
    const producerBodyPinned = importedIdentityPinned && call.bodyRead === true && producer?.moduleKey === ref.moduleKey &&
      HASH.test(producer.sha256 ?? '') && (library && producer.revision === revision ||
        service && producer.deployed === true && Number.isSafeInteger(producer.revision) && producer.revision > 0);
    return { signatureKey: call.actionKey ?? null, originalActionKey: ref?.originalActionKey ?? null,
      kind: externalLogic ? 'external-logic-reference' : library ? 'library-reference' : service ? 'service-reference' : 'unqualified-reference',
      importedModuleType: ref?.moduleType ?? null, producerModuleKey: ref?.moduleKey ?? null,
      importedRevision: revision, consumerSourceSha256: ref?.consumerSourceSha256 ?? null,
      importedIdentityPinned, producerBodyPinned,
      bodyInspection: externalLogic ? 'external-logic-not-in-debugger-model' : producerBodyPinned ? library ? 'imported-library-revision' : 'deployed-service-revision' : 'unqualified',
      ...(externalLogic ? { producerTargetEligible: false, nativeStepInto: 'not-observed' } : {}),
      ...(producerBodyPinned && service ? { deployedRevision: producer.revision, environmentKey: producer.environmentKey } : {}),
      producerSourceSha256: producerBodyPinned ? producer.sha256 : null,
      // Filled only by debug-identity-evidence.mjs (applyIdentityEvidence); never set here.
      producerFramesObserved: false, valuesObserved: false, identityEvidence: null, appUserIdentityProved: false, rolesProved: false, propagationProved: false };
  });
  let producer = target.producerTarget;
  // Defense in depth: a producer target bound to an external-logic signature/module is refused.
  const externalTarget = producer && boundaries.some(b => b.kind === 'external-logic-reference' &&
    (KEY.test(b.signatureKey ?? '') && b.signatureKey === (producer.signatureKey ?? target.key) ||
      KEY.test(b.producerModuleKey ?? '') && b.producerModuleKey === producer.producerModuleKey));
  if (externalTarget) producer = undefined;
  return { schema: 'ssam-odc-native-call-boundary/1', targetActionKey: producer?.actionKey ?? target.key ?? null,
    traceScope: producer?.executable === true ? 'selected-producer-action' : 'selected-local-action',
    producerTargetSelection: externalTarget ? 'external-logic-refused' : producer?.executable === true ? 'exact-imported-reference' : 'unavailable',
    ...(producer ? { selectedSignatureKey: target.key, producerTarget: producer } : {}), boundaries,
    appUserIdentityProved: false, rolesProved: false, propagationProved: false };
}
// Public summary of the external-logic boundaries for the run receipt and status.
export const externalLogicBoundaries = report => (report?.boundaries ?? []).filter(b => b.kind === 'external-logic-reference')
  .map(({ signatureKey, originalActionKey, producerModuleKey, kind, bodyInspection, nativeStepInto, producerTargetEligible }) =>
    ({ signatureKey, originalActionKey, producerModuleKey, kind, bodyInspection, nativeStepInto, producerTargetEligible }));
// The live driver records what the native step-into did at the external call
// node. Observed behavior only: it never claims a platform limit by itself.
export function recordExternalLogicStepInto(boundary, { callNodeKey, before, after } = {}) {
  if (boundary?.kind !== 'external-logic-reference') fail('not_external_logic');
  const top = before?.stack?.at(-1);
  if (!KEY.test(callNodeKey ?? '') || top?.nodeKey !== callNodeKey || !KEY.test(top?.moduleKey ?? '')) fail('step_into_call_node_mismatch');
  const stack = Array.isArray(after?.stack) ? after.stack : null;
  // External = the reference module key; foreign = a frame from no module of the pre-call stack (unattributed, e.g. native code).
  const known = new Set(before.stack.map(frame => frame?.moduleKey).filter(k => KEY.test(k ?? '')));
  const externalFramesObserved = KEY.test(boundary.producerModuleKey ?? '') && !!stack?.some(frame => frame?.moduleKey === boundary.producerModuleKey);
  const foreignFrames = stack ? stack.filter(frame => !known.has(frame?.moduleKey)).length : 0;
  const outcome = !stack?.length ? 'unobserved' : externalFramesObserved ? 'external-frames-observed' : foreignFrames ? 'foreign-frames-observed' :
    stack.at(-1)?.moduleKey === top.moduleKey ? 'next-pause-in-consumer-no-external-frame' : 'unclassified';
  return { schema: 'ssam-odc-external-logic-step-into/1', signatureKey: boundary.signatureKey, producerModuleKey: boundary.producerModuleKey,
    callNodeKey, consumerModuleKey: top.moduleKey, outcome, externalFramesObserved, foreignFrames, phrasing: 'observed-behavior', platformLimitClaimed: false };
}

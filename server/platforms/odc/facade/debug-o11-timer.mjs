// ITimer.WakeTimerAction is the scheduler's generated action signature. Its
// relationship is read from the native model, never inferred from an action name.
const KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error('debug_native_background_timer_' + code); };
function complete(node) {
  if (!node || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length)
    fail('native_projection_incomplete');
}
export function nativeO11Timer(node) {
  complete(node);
  const wake = node.propertyReferences?.WakeTimerAction, action = node.propertyReferences?.Action;
  if (node.kind !== 'Timer' || !KEY.test(node.key ?? '') || wake?.kind !== 'ActionSignature' ||
      wake.key !== node.key + '.#WakeTimer' || action?.kind !== 'ServerAction' || !KEY.test(action.key ?? '') ||
      /^Reference:/.test(action.path ?? '')) fail('native_binding_invalid');
  const signatures = node.children.filter(child => child.key === wake.key);
  if (signatures.length !== 1 || signatures[0].kind !== 'ActionSignature') fail('wake_signature_missing');
  const signature = signatures[0]; complete(signature);
  if (signature.children.length || ['InputParameters', 'OutputParameters'].some(name => {
    const list = signature.propertyReferenceCollections?.[name];
    return !list || list.total !== 0 || list.omitted !== 0 || !Array.isArray(list.items) || list.items.length;
  })) fail('wake_signature_not_empty');
  return { timerKey: node.key, name: node.name, wakeActionKey: wake.key, actionKey: action.key,
    trigger: 'original-wake-timer-action', asynchronous: true, directActivityInvocation: false,
    requestOwnershipProved: false, executionCompleted: false };
}

// Runtime-independent coordination; all values still use the original debugger.
import { selectReturnWire, returnPathKeys, returnChildren, returnTextSlice, returnCompound } from './debug-native-return-wire.mjs';
const fail = code => { throw new Error('debug_native_client_' + code); };
const categories = new Set(['input', 'output', 'local', 'return', 'session', 'site', 'setting', 'client', 'timer']);
const identity = /^[A-Za-z0-9_+:-]{1,200}$/;
const flowExceptionIdentity = /^[A-Za-z0-9_+]{22}\.\#FlowExceptionHandler$/;
function validVariables(variables, modules) {
  return Array.isArray(variables) && variables.every(v => categories.has(v.category) &&
    (identity.test(v.actionKey ?? '') || flowExceptionIdentity.test(v.actionKey ?? '')) &&
    (v.nodeKey === undefined || identity.test(v.nodeKey)) &&
    (v.previousNodeKey == null || identity.test(v.previousNodeKey)) &&
    (v.nativePath === undefined || typeof v.nativePath === 'string' && v.nativePath && v.nativePath.length <= 500 && !/[\r\n\0]/.test(v.nativePath)) &&
    (v.modelKind === undefined || typeof v.modelKind === 'string' && /^[A-Za-z_][A-Za-z0-9_.+`]{0,299}$/.test(v.modelKind)) &&
    identity.test(v.moduleKey ?? '') && (v.category === 'return' || identity.test(v.variableKey ?? '')) &&
    typeof v.name === 'string' && v.name && v.name.length <= 200 && modules.some(m => m.moduleKey === v.moduleKey));
}

// Widget validation state is not the value entered in the input. Only expose
// the native, model-bound validation fields; the credential filter still owns
// other members and also filters the contents of validation messages.
function nativeWidgetState(item, value) {
  if (!/^ServiceStudio\.Plugin\.NRWidgets\.[A-Za-z0-9_]+$/.test(item.spec.modelKind ?? '')) return false;
  const fields = { Id: 'Text', Valid: 'Boolean', ValidationMessage: 'Text' };
  const root = item.spec.nativePath ?? item.spec.name;
  const current = item.nativePath ?? root;
  if (current === root) {
    if (value?.type !== 'Record' || !value.value || typeof value.value !== 'object' || Array.isArray(value.value)) return false;
    const names = Object.keys(value.value);
    return names.length > 0 && names.every(name => Object.hasOwn(fields, name) && value.value[name]?.type === fields[name]);
  }
  const field = current.startsWith(root + '.') ? current.slice(root.length + 1) : null;
  return Object.hasOwn(fields, field) && value?.type === fields[field];
}

// Model categories per runtime. Defined here because the private browser
// bundle admits one import; debug-scope-categories.mjs re-exports it.
const scopeCategories = ['input', 'output', 'local', 'client', 'session', 'site', 'setting', 'timer'];
export const odcSessionVariableEvidence = 'kernel/tests/jobs-odc-negative/session-variable-not-in-odc.json';
const runtimeCategoryLimits = { client: { session: 'client-runtime-has-no-session-variables', site: 'client-runtime-has-no-site-properties',
  setting: 'client-runtime-has-no-settings', timer: 'client-runtime-has-no-timers' }, server: { client: 'server-runtime-has-no-client-variables' } };
// Empty needs a frame-bound model count of 0; without one a missing category is
// only not enumerated. Enumerated addresses are never hidden by these rules.
export function categorizeScope(lane, runtime, metadataCoverage, enumerated) {
  if (!['o11', 'odc'].includes(lane) || !['client', 'server'].includes(runtime)) throw new Error('debug_scope_categories_input_invalid');
  const counts = {};
  for (const v of Array.isArray(enumerated) ? enumerated : []) if (typeof v?.category === 'string') counts[v.category] = (counts[v.category] ?? 0) + 1;
  const model = metadataCoverage?.modelScopeEnumerated === true && metadataCoverage.variableCounts && typeof metadataCoverage.variableCounts === 'object'
    ? metadataCoverage.variableCounts : null;
  const out = { notApplicableToRuntime: [], notApplicableReasons: {}, emptyInModel: [], notEnumerated: [], enumeratedCategories: [],
    categoryCountsBound: model !== null, nativeReturnEnumerated: (counts.return ?? 0) > 0 };
  for (const category of scopeCategories) {
    const limit = lane === 'odc' && category === 'session' ? { reason: 'odc-model-refuses-session-variables', evidence: odcSessionVariableEvidence }
      : runtimeCategoryLimits[runtime][category] ? { reason: runtimeCategoryLimits[runtime][category] } : null;
    if (counts[category]) out.enumeratedCategories.push(category);
    else if (limit) { out.notApplicableToRuntime.push(category); out.notApplicableReasons[category] = limit; }
    else if (model && model[category] === 0) out.emptyInModel.push(category);
    else out.notEnumerated.push(category);
  }
  return out;
}

// Native exception classes only. A specificType replacing .name and every
// message stay private; an unlisted name keeps at most its native family.
const nativeExceptionTypes = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'DOMException',
  'OpenDatabaseException', 'InvalidLoginException', 'NotRegisteredException', 'ViewHasChangedException', 'OutOfContextException',
  'RedirectOccurredException', 'UnhandledOrIgnoredErrorInEventException', 'AbortedRequestException', 'ApplicationBackendUnavailableException',
  'LicensingException', 'IncompatibleProducerException', 'ControllerDisposedException', 'AbortActivityChangeException', 'NumberOverflowException',
  'InvalidJavascriptType', 'ServerException', 'DataBaseException', 'UserException', 'CommunicationException', 'SecurityException',
  'IgnorableSystemException', 'SystemException', 'ServiceException', 'Exception']);
// Data properties only: no getter of the paused application is invoked.
function dataProperty(object, key) {
  for (let p = object, depth = 0; p && depth < 16; p = Object.getPrototypeOf(p), depth++) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return Object.hasOwn(d, 'value') ? d.value : undefined;
  }
}
function nativeExceptionType(error) {
  try {
    if (!error || typeof error !== 'object') return { type: 'unknown', typeRedacted: true };
    const name = dataProperty(error, 'name');
    if (typeof name === 'string' && nativeExceptionTypes.has(name)) return { type: name, typeRedacted: false };
    for (let p = Object.getPrototypeOf(error), depth = 0; p && depth < 8; p = Object.getPrototypeOf(p), depth++) {
      const constructor = Object.getOwnPropertyDescriptor(p, 'constructor')?.value;
      const family = typeof constructor === 'function' ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value : undefined;
      if (typeof family === 'string' && family !== 'Error' && nativeExceptionTypes.has(family)) return { type: 'unknown', family, typeRedacted: true };
    }
  } catch { /* an unreadable error object exposes no type */ }
  return { type: 'unknown', typeRedacted: true };
}

export function redactNativeClientValue(value, privateValues = []) {
  if (typeof value === 'string') {
    for (const secret of privateValues.filter(v => typeof v === 'string' && v.length)) value = value.split(secret).join('[private]');
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactNativeClientValue(v, privateValues));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateValues.some(secret => typeof secret === 'string' && secret.length && key.includes(secret)))
    .map(([key, v]) => [key,
    /password|token|secret|cookie|credential|authorization|username/i.test(key) ? '[private]' : redactNativeClientValue(v, privateValues)]));
}

// Lives exclusively in the private runtime worker. No raw bags or arbitrary JS
// expressions cross this boundary. Metadata must come from the pinned model.
export function createNativeClientInspectionCore({ debuggerObject: dbg, globalObject, platform, modules, variables = [], redact = value => value, privateChannel, privateCapture = false, binaryType, nativeConverter }, { digest, token, byteLength, privateCompare }) {
  if (!['o11', 'odc'].includes(platform) || !Array.isArray(modules) || !modules.length ||
      modules.some(m => !identity.test(m.moduleKey ?? '') || !/^[a-f0-9]{64}$/.test(m.sourceSha256 ?? '')) ||
      !validVariables(variables, modules)) fail('metadata_invalid');
  variables = variables.slice();
  const boundScopes = new Set(variables.filter(v => v.nodeKey).map(v => JSON.stringify([v.moduleKey, v.actionKey, v.nodeKey, v.previousNodeKey ?? null])));
  if (typeof dbg?.evaluateVariable !== 'function' || typeof dbg?.getThreadStack !== 'function') fail('evaluator_unavailable');
  const refs = new Map(), frameHistory = new WeakMap(), sessionId = token(), helperName = '__ssamInspection_' + token(), privateConsumerCapability=token();
  // Worker-held HMAC fingerprints of private captures (Node adapter only). They
  // survive frame/step invalidation and end at stop/dispose; a host channel keeps its own.
  const compare = privateChannel && typeof privateCompare === 'function' ? privateCompare({ sessionId, lane: platform, runtime: 'client' }) : undefined;
  const compareMember = compare?.member(sessionId);
  let generation = 0, stop = 0, evaluation = 0, frame = 0, ccid, paused = false, disposed = false;
  let nativeReturns = new WeakMap();
  let pauseRequest, pauseReason;
  const originalFunctionCall = dbg.handleFunctionCall;
  const functionCallDescriptor = Object.getOwnPropertyDescriptor(dbg, 'handleFunctionCall');
  let observedFunctionCall;
  if ((privateChannel || privateCapture) && typeof binaryType === 'function' && typeof originalFunctionCall === 'function') {
    // The native callback is invoked exactly once by the original debugger.
    // Keep its result only while that debugger handles the return breakpoint,
    // before its native converter replaces BinaryData content with byte length.
    observedFunctionCall = function(callback, dataType, callContextId) {
      if (disposed || this.isInSession === false || typeof callback !== 'function') return originalFunctionCall.apply(this, arguments);
      let owner, previous;
      const args = Array.from(arguments);
      args[0] = function() {
        const result = callback.apply(this, arguments);
        try {
          const state = disposed ? null : dbg.getThreadState(callContextId);
          owner = state?.getCallOnStack?.(state.stackLevel - 1);
          if (owner && typeof owner === 'object') {
            previous = nativeReturns.get(owner);
            nativeReturns.set(owner, { value: result, callContextId, dataType });
          }
        } catch { owner = undefined; } // Missing observation cannot change the action result.
        return result;
      };
      try { return originalFunctionCall.apply(this, args); }
      finally { if (owner) { if (previous && !disposed) nativeReturns.set(owner, previous); else nativeReturns.delete(owner); } }
    };
    Object.defineProperty(dbg, 'handleFunctionCall', { configurable: true, writable: true, value: observedFunctionCall });
  }
  const context = () => ({ sessionId, platform, runtime: 'client', stop, generation, callContextId: ccid, frame });
  function invalidate() { generation++; refs.clear(); return privateChannel?.invalidate() ?? {completed:true,pending:0}; }
  function requirePause() { if (disposed || !paused) fail('stale_reference'); }
  function frames() {
    return (dbg.getThreadStack(ccid) ?? []).map((s, index) => ({ frame: index, elementKey: s.elementKey,
      moduleName: s.moduleName, action: s.elementName, kind: s.elementType,
      breakpoint: s.currentBreakpoint, previousBreakpoint: s.previousBreakpoint ?? null, breakpointType: s.breakpointType,
      functionLeft: s.functionLeft ?? null,
      nativeReturnAvailable: Number.isInteger(dbg.BreakpointType?.AtFunctionReturn) && s.breakpointType === dbg.BreakpointType.AtFunctionReturn }));
  }
  function previousNode(current, moduleKey) {
    if (current?.previousBreakpoint == null) return null;
    const [previousModule, previousKey] = String(current.previousBreakpoint).split(':');
    if (previousModule !== moduleKey || !identity.test(previousKey ?? '')) fail('previous_scope_unavailable');
    return previousKey;
  }
  function makeRef(spec, nativePath = undefined, returnKeys = []) {
    nativePath ??= spec.nativePath;
    const ref = token(); refs.set(ref, { spec, nativePath, returnKeys, generation, last: undefined });
    return { ref, name: spec.name, category: spec.category, nativePath: nativePath ?? null,
      moduleKey: spec.moduleKey, sourceSha256: modules.find(m => m.moduleKey === spec.moduleKey).sourceSha256, ...context() };
  }
  function getRef(ref) { requirePause(); const value = refs.get(ref); if (!value || value.generation !== generation) fail('stale_reference'); return value; }
  function nativeHistory(item, hash, representation = 'wire') {
    const nativeFrame=dbg.getThreadState(ccid)?.getCallOnStack?.(frame);
    let previousStop=null,changedSincePreviousStop=null;
    if(nativeFrame && typeof nativeFrame==='object'){
      let history=frameHistory.get(nativeFrame);if(!history){history=new Map();frameHistory.set(nativeFrame,history);}
      const key=JSON.stringify([item.spec.moduleKey,item.spec.actionKey,item.spec.variableKey,item.nativePath,item.returnKeys,representation]);
      const old=history.get(key);
      if(old && old.stop!==stop){previousStop=old.stop;changedSincePreviousStop=old.hash!==hash;}
      history.set(key,{stop,hash});
    }
    return {previousStop,changedSincePreviousStop};
  }
  function returnValue(item, detail = 1, privacy = null) {
    let value;
    try { value = dbg.evaluateVariable(ccid, frame, item.spec.actionKey, '', '$return', detail); }
    catch { fail('evaluation_failed'); }
    if (value === undefined) fail('evaluation_unavailable');
    // Select only after redacting the entire tree: a child reference must never
    // bypass privacy filtering applied to its parent or a sensitive field name.
    const selected = selectReturnWire(redactNativeClientValue(redact(value)), item.returnKeys);
    if (privacy) {
      const original = selectReturnWire(value, item.returnKeys);
      privacy.nativeDigest = digest(original);
      privacy.redacted = privacy.nativeDigest !== digest(selected);
    }
    return selected;
  }
  function evaluate(ref, detail = 1) {
    const item = getRef(ref);
    if (!Number.isInteger(detail) || detail < 0 || detail > 8) fail('detail_invalid');
    let value; const privacy = { redacted: false };
    try { value = item.spec.category === 'return' ? returnValue(item, detail, privacy)
      : dbg.evaluateVariable(ccid, frame, item.spec.actionKey, item.spec.variableKey ?? '', item.nativePath, detail); }
    catch { fail('evaluation_failed'); }
    if (value === undefined) fail('evaluation_unavailable');
    // Native wrappers are already wire values. Redaction never truncates them;
    // a transport budget refuses the read and leaves its reference expandable.
    const hash = privacy.nativeDigest ?? digest(value), changed = item.last === undefined ? null : item.last !== hash;
    // The native call-state object identifies this invocation, including
    // recursion. Never compare merely by action name or reused stack index.
    const {previousStop,changedSincePreviousStop}=nativeHistory(item,hash);
    const compound = value && ['Record', 'RecordList'].includes(value.type);
    // A data-action record named GetUserNameFromServer is a scope, not
    // itself a username. Preserve its nonprivate fields; redact UserName
    // leaves recursively just as in every other native record.
    const namedPrivate = !nativeWidgetState(item, value) && (compound ? /password|token|secret|cookie|credential|authorization/i : /password|token|secret|cookie|credential|authorization|username/i).test(item.spec.name + '.' + (item.nativePath ?? ''));
    value = namedPrivate
      ? { type: value.type, value: '[private]' } : redact(value);
    const redacted = namedPrivate || privacy.redacted || digest(value) !== hash;
    const encoded = JSON.stringify(value);
    if (byteLength(encoded) > 2 * 1024 * 1024) return { ...context(), ref, omitted: true,
      reason: 'transport_budget', ...(item.spec.category === 'return'
        ? { expandable: true, nativePathAccess: false, nativeValueProjection: true,
            continuation: { op: returnCompound(value) ? 'children' : 'slice', ref, offset: 0 } }
        : { continuation: { op: 'expand', ref } }), evaluation: ++evaluation };
    item.last = hash;
    const nested = value && ['Record', 'RecordList'].includes(value.type);
    // The native debugger's BinaryData wire contains a byte count, not the
    // binary content. This also applies to return values and expanded fields.
    const nativeSummary = value?.type === 'BinaryData';
    const expandable = nested && !(item.spec.category === 'return' && value.value === null);
    return { ...context(), ref, evaluation: ++evaluation, changed, previousStop, changedSincePreviousStop, value,
      deferred: nested && value.value === null, expandable, redacted, valueComplete: !nested && !redacted && !nativeSummary,
      ...(nativeSummary ? {nativeSummary:true,limitation:'native_binary_content_unavailable'} : {}),
      ...(expandable ? { continuation: { op: item.spec.category === 'return' ? 'children' : 'expand', ref }, nativePathAccess: item.spec.category !== 'return' } : {}),
      ...(item.spec.category === 'return' ? { nativeValueProjection: true,
        ...(nested && !expandable ? { limitation: 'native_return_deferred' } : {}) } : {}) };
  }
  function dispatch(input) {
    if (!input || typeof input !== 'object') fail('operation_invalid');
    if (input.op === 'request-pause') {
      if (disposed || paused || !dbg.isInSession) fail('pause_not_running');
      if (pauseRequest) fail('pause_request_pending');
      if (typeof dbg.callContexts?.keys !== 'function' || typeof dbg.stepInto !== 'function') fail('pause_unavailable');
      const contexts = [...dbg.callContexts.keys()].filter(id => {
        if (!Number.isInteger(id)) return false;
        const stack = dbg.getThreadStack(id);
        return stack?.length && stack.every(f => modules.some(m => String(f.elementKey).split(':')[0] === m.moduleKey));
      });
      if (!contexts.length) fail('pause_no_bound_context');
      // Record before the first native command: a partial/uncertain request
      // cannot be retried merely because its acknowledgement was lost.
      pauseRequest = { requested: true, mode: 'native-next-node', callContextIds: contexts };
      for (const id of contexts) dbg.stepInto(id);
      return { ...context(), ...pauseRequest, paused: false };
    }
    if (input.op === 'pause') {
      // Called only over the private CDP connection at the native debugger frame.
      // O11 stores the id in callDebugger's argument; ODC additionally mirrors
      // it on window. Inspector reads the argument of that original frame.
      ccid = input.callContextId ?? globalObject.callContextId;
      if (input.nativeDebugger !== undefined && input.nativeDebugger !== dbg) fail('context_unavailable');
      if (!Number.isInteger(ccid) || !dbg.getThreadState(ccid)) fail('context_unavailable');
      if (pauseRequest) {
        pauseRequest.callContextIds = pauseRequest.callContextIds.filter(id => id !== ccid);
        if (!pauseRequest.callContextIds.length) pauseRequest = undefined;
      }
      // handleException sets this native flag only around its own callDebugger
      // when pauseOnAllExceptions is enabled; breakpoint and step stops lack it.
      let onException = false;
      try { onException = (typeof dbg.isPausedOnException === 'function' ? dbg.isPausedOnException() : dbg.pausedOnAnException) === true; } catch { onException = false; }
      let error;
      try { error = onException && typeof dbg.exceptionsMap?.get === 'function' ? dbg.exceptionsMap.get(ccid) : undefined; } catch { error = undefined; }
      pauseReason = onException ? { reason: 'exception', exception: nativeExceptionType(error) } : undefined;
      invalidate(); paused = true; stop++; frame = frames().length - 1;
      return { ...context(), paused: true, ...pauseReason, frames: frames() };
    }
    if (input.op === 'invalidate') { paused = false; invalidate(); return { ...context(), paused: false }; }
    requirePause();
    if (input.op === 'status') return { ...context(), paused: true, ...pauseReason, frames: frames() };
    if (input.op === 'private-compare') {
      // Booleans over fingerprints already taken from native values; caller
      // values are refused, nothing is evaluated and no hash leaves the worker.
      if (!compare) fail('private_compare_unavailable');
      if (Object.keys(input).some(k => !['op', 'handles', 'mode', 'anchor'].includes(k))) fail('private_compare_caller_value_refused');
      try { return { ...context(), ...compare.compare(input.handles, { ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.anchor !== undefined ? { anchor: input.anchor } : {}) }) }; }
      catch (error) { fail('private_compare_' + (/^debug_private_compare_([a-z_]+)$/.exec(error?.message ?? '')?.[1] ?? 'failed')); }
    }
    if (input.op === 'frame') {
      if (!Number.isInteger(input.frame) || input.frame < 0 || input.frame >= frames().length) fail('frame_invalid');
      frame = input.frame; invalidate(); return { ...context(), frames: frames() };
    }
    if (input.op === 'bind-scope') {
      // Private coordinator command: its metadata is read from the already
      // pinned publication, never supplied by the public inspection caller.
      const current = frames()[frame], [moduleKey, actionKey] = String(current?.elementKey ?? '').split(':');
      const nodeKey = String(current?.breakpoint ?? '').split(':')[1];
      const previousNodeKey = previousNode(current, moduleKey);
      if (input.stop !== stop || input.generation !== generation || input.moduleKey !== moduleKey ||
        input.functionKey !== actionKey || input.nodeKey !== nodeKey ||
        (input.previousNodeKey ?? null) !== previousNodeKey ||
        modules.find(m => m.moduleKey === moduleKey)?.sourceSha256 !== input.sourceSha256 ||
        !validVariables(input.variables, modules) || input.variables.some(v => v.moduleKey !== moduleKey || v.actionKey !== actionKey || v.nodeKey !== nodeKey || (v.previousNodeKey ?? null) !== previousNodeKey))
        fail('metadata_invalid');
      const scopeIdentity = JSON.stringify([moduleKey, actionKey, nodeKey, previousNodeKey]);
      if (boundScopes.has(scopeIdentity)) fail('metadata_already_bound');
      variables.push(...input.variables);
      boundScopes.add(scopeIdentity);
      return { ...context(), metadataBound: true, variablesAdded: input.variables.length };
    }
    if (input.op === 'scope') {
      const current = frames()[frame], [moduleKey, actionKey] = String(current?.elementKey ?? '').split(':');
      const nodeKey = String(current?.breakpoint ?? '').split(':')[1];
      const previousNodeKey = previousNode(current, moduleKey);
      const selected = variables.filter(v => v.moduleKey === moduleKey && v.actionKey === actionKey && (!v.nodeKey || v.nodeKey === nodeKey && (v.previousNodeKey ?? null) === previousNodeKey));
      if (current.nativeReturnAvailable && !selected.some(v => v.category === 'return')) selected.push({
        moduleKey, actionKey, nodeKey, previousNodeKey, variableKey: '', name: '$return', category: 'return' });
      // Frame binding identity for nativeBoundScopeCoverage. The coverage match
      // decides frame-bound counts; here only a scope bound for exactly this
      // frame identity supplies counts, so 0 means empty in that model scope.
      const metadataBound = modules.some(m => m.moduleKey === moduleKey) && identity.test(nodeKey ?? '') &&
        (identity.test(actionKey ?? '') || flowExceptionIdentity.test(actionKey ?? ''));
      const scopeIdentity = JSON.stringify([moduleKey, actionKey, nodeKey, previousNodeKey]);
      const boundCounts = boundScopes.has(scopeIdentity) ? { modelScopeEnumerated: true, variableCounts: Object.fromEntries(scopeCategories.map(c =>
        [c, variables.filter(v => v.category === c && v.nodeKey && JSON.stringify([v.moduleKey, v.actionKey, v.nodeKey, v.previousNodeKey ?? null]) === scopeIdentity).length])) } : null;
      const categorized = categorizeScope(platform, 'client', boundCounts, selected);
      return { ...context(), variables: selected.map(v => makeRef(v, v.category === 'return' ? '$return' : undefined)),
        scopeComplete: false, metadataBound, ...(metadataBound ? { context: { moduleKey, functionKey: actionKey, nodeKey, previousNodeKey } } : {}),
        ...categorized, unavailableCategories: categorized.notEnumerated,
        scopeAuthority: 'published-model-selection', metadataSelected: selected.length };
    }
    if(input.op==='private-consume'){
      if(!privateChannel || input.consumerCapability!==privateConsumerCapability)fail('private_consumer_unauthorized');
      return {...context(),value:privateChannel.consume(input.descriptor,context())};
    }
    if (input.op === 'private-read' || input.op === 'private-capture') {
      const capture = input.op === 'private-capture';
      if (capture && (!privateCapture || input.consumerCapability !== privateConsumerCapability)) fail('private_consumer_unauthorized');
      const item=getRef(input.ref),detail=input.detail??1;
      if(!Number.isInteger(detail)||detail<0||detail>8)fail('detail_invalid');
      if(!capture && !privateChannel)fail('private_channel_unavailable');
      let value, convertedBinary;
      const binary=input.binary===true;
      // Observe the object selected by the ORIGINAL converter. Its BinaryData
      // branch reads length after resolving the native record/list path. Never
      // reproduce that path traversal or load deferred binary content here.
      const nestedReturn=item.spec.category==='return' && item.returnKeys.length>0;
      const canRegisterReturn=typeof dbg.registerMetaInfo==='function';
      const lengthDescriptor=binary && (item.spec.category!=='return' || nestedReturn && (typeof nativeConverter?.to==='function'||canRegisterReturn)) && typeof binaryType==='function'
        ? Object.getOwnPropertyDescriptor(binaryType.prototype,'length') : undefined;
      const canObserve=lengthDescriptor?.configurable===true && typeof lengthDescriptor.get==='function';
      const observedBinaries=new Set();
      const observeLength=function(){
        const length=lengthDescriptor.get.call(this);
        if(Object.getPrototypeOf(this)===binaryType.prototype)observedBinaries.add(this);
        return length;
      };
      try{
        if(canObserve)Object.defineProperty(binaryType.prototype,'length',{...lengthDescriptor,get:observeLength});
        value=dbg.evaluateVariable(ccid,frame,item.spec.actionKey,item.spec.category==='return'?'':item.spec.variableKey??'',
        item.spec.category==='return'?'$return':item.nativePath,detail);
        if(item.spec.category==='return')value=selectReturnWire(value,item.returnKeys);
        if(binary && nestedReturn && canObserve){
          const nativeFrame=dbg.getThreadState(ccid)?.getCallOnStack?.(frame),observed=nativeFrame && nativeReturns.get(nativeFrame);
          if(!observed || observed.callContextId!==ccid || !frames()[frame]?.nativeReturnAvailable || typeof dbg.splitPath!=='function')fail('binary_content_unavailable');
          const path=item.returnKeys.map(key=>/^\[\d+\]$/.test(key)?key:'.'+key).join('');
          if(JSON.stringify(returnPathKeys(path))!==JSON.stringify(item.returnKeys))fail('path_invalid');
          let nativeValue;
          if(typeof nativeConverter?.to==='function')nativeValue=nativeConverter.to(observed.value,nativeFrame.varBag?.callContext,dbg.splitPath('$return'+path),detail,observed.dataType);
          else {
            // ODC keeps its converter private. Register the already observed
            // return as a temporary native watch; the original evaluator still
            // resolves every child and invokes its own converter. No action is
            // called again, and no raw record/list traversal is implemented.
            const descriptor=Object.getOwnPropertyDescriptor(dbg,'metaInfoMap'),oldMap=dbg.metaInfoMap;
            const key='__ssamReturn_'+token(),metadata={dataType:observed.dataType,getter:()=>observed.value};
            let map;
            try{
              if(oldMap?.has(key))fail('binary_content_unavailable');
              dbg.registerMetaInfo({[key]:metadata});map=dbg.metaInfoMap;
              if(map?.get(key)!==metadata)fail('binary_content_unavailable');
              nativeValue=dbg.evaluateVariable(ccid,frame,item.spec.actionKey,key,'$return'+path,detail);
            }finally{
              if(map?.get(key)===metadata)map.delete(key);
              if(oldMap===undefined && dbg.metaInfoMap===map && map?.size===0){
                if(descriptor)Object.defineProperty(dbg,'metaInfoMap',descriptor);else delete dbg.metaInfoMap;
              }
            }
          }
          if(nativeValue?.type!=='BinaryData'||value?.type!=='BinaryData'||nativeValue.value!==value.value)fail('binary_content_changed');
        }
        if(observedBinaries.size===1)convertedBinary=observedBinaries.values().next().value;
      }catch{fail('evaluation_failed');}
      finally{
        if(canObserve)Object.defineProperty(binaryType.prototype,'length',lengthDescriptor);
        observedBinaries.clear();
      }
      if(value===undefined)fail('evaluation_unavailable');
      if(binary){
        const isReturn = item.spec.category === 'return';
        if(value.type!=='BinaryData'||(isReturn ? item.returnKeys.length !== 0 && !convertedBinary : !convertedBinary && item.nativePath!==item.spec.nativePath)||
          (!isReturn && typeof dbg.innerEvaluateVariable!=='function')||typeof binaryType!=='function')fail('binary_content_unavailable');
        // Use the native evaluator and native BinaryData accessor. Never call
        // loadContent/toBlob or fetch a remote/offline-backed binary value.
        const contentGetter=Object.getOwnPropertyDescriptor(binaryType.prototype,'content')?.get;
        if(typeof contentGetter!=='function')fail('binary_content_unavailable');
        let raw,content;
        try{
          if (isReturn) {
            const nativeFrame = dbg.getThreadState(ccid)?.getCallOnStack?.(frame);
            const observed = nativeFrame && nativeReturns.get(nativeFrame);
            if (!observed || observed.callContextId !== ccid || !frames()[frame]?.nativeReturnAvailable) fail('binary_content_unavailable');
            raw = convertedBinary??observed.value;
          } else raw=convertedBinary??dbg.innerEvaluateVariable(ccid,frame,item.spec.actionKey,item.spec.variableKey);
          if(!raw||Object.getPrototypeOf(raw)!==binaryType.prototype)fail('binary_content_unavailable');
          content=contentGetter.call(raw);
        }catch{fail('binary_content_unavailable');}
        if(content===null&&value.value===0){
          const urlGetter=Object.getOwnPropertyDescriptor(binaryType.prototype,'url')?.get;
          const blobGetter=Object.getOwnPropertyDescriptor(binaryType.prototype,'cachedBlob')?.get;
          const offline=Object.getOwnPropertyDescriptor(raw,'getOfflineContent');
          // The native constructor represents an empty inline value as null.
          // A deferred Blob/URL can also have no content, so require absence
          // of every native backing source before observing zero bytes.
          if(typeof urlGetter!=='function'||typeof blobGetter!=='function'||
            urlGetter.call(raw)||blobGetter.call(raw)!==null)fail('binary_content_unavailable');
          if(platform==='odc'){
            // ODC stores the loader in a private WeakMap. Its own comparison
            // checks loader presence; comparing to an inline empty instance
            // proves absence without invoking or reimplementing that loader.
            const equals=Object.getOwnPropertyDescriptor(binaryType.prototype,'fastEquals')?.value;
            if(typeof equals!=='function'||equals.call(raw,new binaryType(''))!==true)fail('binary_content_unavailable');
          }else if(!offline||!Object.hasOwn(offline,'value')||offline.value!==undefined)fail('binary_content_unavailable');
          content='';
        }
        if(typeof content!=='string')fail('binary_content_unavailable');
        if(content.length>2*1024*1024)fail('binary_content_budget');
        if(content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(content))fail('binary_content_invalid');
        const padding=content.endsWith('==')?2:content.endsWith('=')?1:0;
        const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        if(padding&& (alphabet.indexOf(content[content.length-padding-1]) & (padding===2?15:3)))fail('binary_content_invalid');
        const length=content.length/4*3-padding;
        if(!Number.isSafeInteger(value.value)||value.value!==length)fail('binary_content_changed');
        value={type:'BinaryData',value:content,encoding:'base64',byteLength:length};
      }
      const variable={...item.spec,ref:input.ref,nativePath:item.nativePath??null,
        sourceSha256:modules.find(m=>m.moduleKey===item.spec.moduleKey).sourceSha256};
      // Only the private transport may carry this envelope to its host-side
      // vault. It is never a public command result or a browser disk record.
      const envelope={context:context(),variable,value};
      const {compareHandle,...privateInspection}=(capture ? undefined : privateChannel.publish(envelope)) ?? {};
      // Fingerprint the same native value at capture; only its opaque handle leaves.
      let privateCompareHandle=compareHandle;
      if(!capture && privateCompareHandle===undefined && compareMember){try{privateCompareHandle=compareMember.fingerprint(envelope);}catch{privateCompareHandle=null;}}
      const hash=digest(value),previous=binary?item.lastBinary:item.last,changed=previous===undefined?null:previous!==hash;
      const history=nativeHistory(item,hash,binary?'binary-base64':'wire');if(binary)item.lastBinary=hash;else item.last=hash;
      return {...context(),ref:input.ref,evaluation:++evaluation,...(capture ? {privateEnvelope:envelope} : {privateInspection,
        ...(privateCompareHandle!==undefined ? {privateCompareHandle} : {})}),changed,...history,
        ...(binary?{nativeRepresentation:'binary-base64',nativeContentComplete:true}:{}),valueComplete:false,privateValueReturnedPublicly:false};
    }
    if (input.op === 'read' || input.op === 'refresh') return evaluate(input.ref, input.detail);
    if (input.op === 'read-many') {
      if (!Array.isArray(input.refs) || !input.refs.length || input.refs.length > 500 || new Set(input.refs).size !== input.refs.length) fail('references_invalid');
      // Validate every capability before the first native evaluation. A stale
      // item must not produce a partially evaluated, apparently current batch.
      for (const ref of input.refs) getRef(ref);
      const detail = input.detail ?? 1;
      if (!Number.isInteger(detail) || detail < 0 || detail > 8) fail('detail_invalid');
      const values = input.refs.map(ref => {
        try { return evaluate(ref, detail); }
        catch (error) {
          if (!['debug_native_client_evaluation_unavailable', 'debug_native_client_evaluation_failed'].includes(error?.message)) throw error;
          // A native watch may be unavailable in this frame (for example an
          // unmounted widget). Preserve the other native results and expose
          // that failure explicitly; never replace it with a fabricated value.
          return { ...context(), ref, ok: false, error: error.message, unavailable: true, valueComplete: false };
        }
      });
      return { ...context(), values, evaluationFailures: values.filter(v => v.ok === false).length };
    }
    if (input.op === 'expand') {
      const parent = getRef(input.ref);
      if (parent.spec.category === 'return') {
        const keys = [...parent.returnKeys, ...returnPathKeys(input.path)];
        if (keys.length > 64) fail('path_invalid');
        const child = makeRef(parent.spec, '$return', keys);
        return { ...evaluate(child.ref, input.detail), parentRef: input.ref };
      }
      // Native path grammar is data, never JavaScript. First segment denotes the
      // root and is ignored by the native converter, as in the Studio helper.
      if (typeof input.path !== 'string' || !/^(?:\.[A-Za-z_$][\w$ ]*|\[\d+\]){1,64}$/.test(input.path)) fail('path_invalid');
      const child = makeRef(parent.spec, (parent.nativePath ?? parent.spec.name) + input.path);
      return { ...evaluate(child.ref, input.detail), parentRef: input.ref };
    }
    if (input.op === 'children' || input.op === 'slice') {
      const parent = getRef(input.ref);
      if (input.op === 'children' && parent.spec.category !== 'return') {
        const observed = evaluate(input.ref, 1);
        if (observed.omitted) fail('children_transport_budget');
        const { keys, ...page } = returnChildren(observed.value, input.offset, input.limit);
        // Child addresses follow the same grammar as explicit native expand.
        // Never turn an arbitrary field label into an evaluator expression.
        const paths = keys.map(name => /^\[\d+\]$/.test(name) ? name : '.' + name);
        if (paths.some(part => !/^(?:\.[A-Za-z_$][\w$ ]*|\[\d+\])$/.test(part))) fail('path_invalid');
        const root = parent.nativePath ?? parent.spec.name;
        if (paths.some(part => (root + part).length > 2048)) fail('path_invalid');
        const children = paths.map((part, index) => ({ ...makeRef(parent.spec, root + part), name: keys[index] }));
        return { ...context(), ref: input.ref, ...page, children, redacted: observed.redacted,
          evaluation: observed.evaluation, valueSha256: digest(observed.value), nativeValueProjection: true,
          scopeComplete: false, nativePathAccess: true,
          continuation: page.nextOffset == null ? null : { op: 'children', ref: input.ref, offset: page.nextOffset, limit: input.limit ?? 150 } };
      }
      if (input.op === 'slice' && parent.spec.category !== 'return') {
        // Use the same native evaluation and privacy filtering as read. The
        // page is a projection of that wire value, never a runtime expression.
        const observed = evaluate(input.ref, 1);
        if (observed.omitted) fail('text_transport_budget');
        const page = returnTextSlice(observed.value, input.offset, input.limit);
        return { ...context(), ref: input.ref, ...page, redacted: observed.redacted,
          valueComplete: !observed.redacted && page.offset === 0 && page.nextOffset === null,
          evaluation: observed.evaluation, valueSha256: digest(observed.value), nativeValueProjection: true,
          continuation: page.nextOffset == null ? null : { op: 'slice', ref: input.ref, offset: page.nextOffset, limit: input.limit ?? 8192 } };
      }
      if (parent.spec.category !== 'return') fail('return_reference_required');
      const privacy = { redacted: false }, value = returnValue(parent, 1, privacy);
      if (input.op === 'slice') {
        const page = returnTextSlice(value, input.offset, input.limit);
        return { ...context(), ref: input.ref, ...page, redacted: privacy.redacted, valueComplete: !privacy.redacted && page.offset === 0 && page.nextOffset === null,
          evaluation: ++evaluation, valueSha256: digest(value), nativeValueProjection: true,
          continuation: page.nextOffset == null ? null : { op: 'slice', ref: input.ref, offset: page.nextOffset, limit: input.limit ?? 8192 } };
      }
      const { keys, ...page } = returnChildren(value, input.offset, input.limit);
      if (parent.returnKeys.length >= 64 && keys.length) fail('path_invalid');
      const children = keys.map(name => ({ ...makeRef(parent.spec, '$return', [...parent.returnKeys, name]), name }));
      return { ...context(), ref: input.ref, ...page, children, evaluation: ++evaluation, valueSha256: digest(value), nativeValueProjection: true,
        continuation: page.nextOffset == null ? null : { op: 'children', ref: input.ref, offset: page.nextOffset, limit: input.limit ?? 150 } };
    }
    if (['continue', 'stepInto', 'stepOver', 'stepOut', 'stop'].includes(input.op)) {
      if (input.op === 'stop') { compare?.close(); dbg.endSession(); } else dbg[input.op](ccid);
      paused = false; const privateInspectionCleanup=invalidate(); return { ...context(), paused: false, command: input.op,privateInspectionCleanup };
    }
    fail('operation_invalid');
  }
  Object.defineProperty(globalObject, helperName, { configurable: true, value: input => {
    try { return { ok: true, result: dispatch(input) }; }
    catch (error) { return { ok: false, context: context(), error: /^debug_native_client_[a-z_]+$/.test(error.message) ? error.message : 'debug_native_client_evaluation_failed' }; }
  } });
  return {
    helperName,privateConsumerCapability,
    enable({ breakpoints = [], pauseOnExceptions = false } = {}) {
      if (!Array.isArray(breakpoints) || breakpoints.length > 200 || breakpoints.some(b => !identity.test(b) || !modules.some(m => b.startsWith(m.moduleKey + ':')))) fail('breakpoints_invalid');
      for (const m of modules) dbg.allowBreakpointsFromModule(m.moduleKey);
      dbg.addBreakpoints(breakpoints); dbg.pauseOnAllExceptions(pauseOnExceptions === true);
    },
    finish() { paused = false; return invalidate(); },
    dispose() { disposed = true; paused = false; nativeReturns = new WeakMap();
      if (observedFunctionCall && dbg.handleFunctionCall === observedFunctionCall) {
        if (functionCallDescriptor) Object.defineProperty(dbg, 'handleFunctionCall', functionCallDescriptor);
        else delete dbg.handleFunctionCall;
      }
      invalidate(); compare?.close(); const cleanup=privateChannel?.close()??{completed:true,pending:0};delete globalObject[helperName];return cleanup; },
  };
}


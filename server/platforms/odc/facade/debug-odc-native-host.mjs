// Private Node host for the published runtime. Requires --experimental-vm-modules.
// Generated action bodies and native authentication/permissions run unchanged.
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readOdcRuntimeSources, resolveOdcRuntimeEntry } from './debug-odc-native-assets.mjs';
import { createOdcNativeTransport, odcNativeEndpoints } from './debug-odc-native-transport.mjs';
import { sameAppUserTarget } from './debug-app-user.mjs';
import { publicWrapperBody } from './debug-app-user-worker.mjs';
import { nativeWireOutput } from './debug-native-wire-output.mjs';
import { nativeOutputShape } from './debug-native-output-shape.mjs';
import { nativeOutputComparison } from './debug-native-output-comparison.mjs';
import { nativeDataActionOutputs } from './debug-odc-native-data-output.mjs';
import { prepareOdcNativeContext } from './debug-odc-native-context.mjs';
import { createOdcNativeEvidence } from './debug-odc-native-evidence.mjs';
import { keyToGuid } from './debug-odc-native-runtime.mjs';
import { qualifyClientLocalRuntime, createClientLocalNetworkBarrier } from './debug-odc-native-client-local.mjs';
import { sanitizeNativeErrorMessage } from './debug-odc-native-error-message.mjs';
import { createNativeClientInspection, openNativeClientInspector, redactNativeClientValue, clientInspectionEnableOptions } from './debug-native-client-inspection.mjs';
import { createPrivateInspectionChannel } from './debug-private-inspection.mjs';

const fail = code => { throw new Error('debug_odc_native_' + code); };
const safeError = error => /^debug_odc_native_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_native_execution_failed';
const KNOWN_EXCEPTIONS = new Set(['UserException', 'SecurityException', 'NotRegisteredException', 'InvalidLoginException', 'ServerException', 'CommunicationException', 'DataBaseException', 'ServiceException']);
const INVOCATION_STAGES = new Set(['identity-before-invoke', 'permissions', 'native-context', 'arguments', 'timeout-context',
  'native-invocation', 'settle', 'identity-after-invoke', 'outputs']);
const ERROR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'DOMException', ...KNOWN_EXCEPTIONS]);
// Literal families and codes from the published runtime's Exceptions and error
// enums. Server/User/Database exceptions may replace .name with specificType;
// that free-form value must never become a public classification.
const NATIVE_EXCEPTION_FAMILIES = ['OpenDatabaseException', 'InvalidLoginException', 'NotRegisteredException',
  'ViewHasChangedException', 'OutOfContextException', 'RedirectOccurredException', 'UnhandledOrIgnoredErrorInEventException',
  'AbortedRequestException', 'ApplicationBackendUnavailableException', 'LicensingException', 'IncompatibleProducerException',
  'ControllerDisposedException', 'AbortActivityChangeException', 'NumberOverflowException', 'InvalidJavascriptType',
  'ServerException', 'DataBaseException', 'UserException', 'CommunicationException', 'SecurityException',
  'IgnorableSystemException', 'SystemException', 'Exception'];
const NATIVE_EXCEPTION_NAMES = new Set(NATIVE_EXCEPTION_FAMILIES);
const NATIVE_ERROR_CODES = new Set(['OS-BEW-00000', 'OS-CLRT-00000',
  'OS-CLRT-40100', 'OS-CLRT-40101', 'OS-CLRT-40102', 'OS-CLRT-40103', 'OS-CLRT-40104',
  'OS-CLRT-40105', 'OS-CLRT-40106', 'OS-CLRT-40107', 'OS-CLRT-40108', 'OS-CLRT-40109',
  'OS-CLRT-40110', 'OS-CLRT-40111', 'OS-CLRT-40112', 'OS-CLRT-40113', 'OS-CLRT-40114',
  'OS-CLRT-40115', 'OS-CLRT-40116', 'OS-CLRT-40117', 'OS-CLRT-40118',
  'OS-CLRT-40300', 'OS-CLRT-40301', 'OS-CLRT-40302', 'OS-CLRT-40303',
  'OS-CLRT-60301', 'OS-CLRT-60302', 'OS-CLRT-60303', 'OS-CLRT-60304', 'OS-CLRT-60407',
  'OS-CLRT-60800', 'OS-CLRT-60801', 'OS-CLRT-60900', 'OS-CLRT-60901', 'OS-CLRT-60902',
  'OS-CLRT-60903', 'OS-CLRT-60904', 'OS-CLRT-60905', 'OS-CLRT-60906', 'OS-CLRT-60907',
  'OS-CLRT-60908', 'OS-CLRT-60909', 'OS-CLRT-61000', 'OS-CLRT-61001', 'OS-CLRT-61100', 'OS-CLRT-61101']);
function nativeExceptionFamily(error, nativeExceptions) {
  for (const family of NATIVE_EXCEPTION_FAMILIES) {
    const constructor = nativeExceptions?.[family];
    if (typeof constructor === 'function' && error instanceof constructor) return family;
  }
  return 'unknown';
}
export function nativeResponseDiagnostic(value, privateContext) {
  // Matches the SDK isSuccessResponsePayload/isErrorResponsePayload contract.
  // These are classifications of a response, not evidence of action execution.
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const version = object && value.versionInfo;
  const common = object && typeof value.clientSettingsHash === 'string' && typeof value.shouldRefreshToken === 'boolean' &&
    version !== null && typeof version === 'object' && typeof version.hasApiVersionChanged === 'boolean' && typeof version.hasModuleVersionChanged === 'boolean';
  const error = common && typeof value.exception === 'object' && (typeof value.status === 'number' || value.status === undefined);
  const success = common && (!('exception' in value) || value.exception === undefined);
  return { shape: error ? 'native-error' : success ? 'native-success' : 'unclassified',
    ...(error ? { status: Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
      exceptionFamily: NATIVE_EXCEPTION_NAMES.has(value.exception?.name) ? value.exception.name : 'unknown',
      errorCode: NATIVE_ERROR_CODES.has(value.exception?.errorCode) ? value.exception.errorCode : 'unknown',
      hasSpecificType: typeof value.exception?.specificType === 'string' && value.exception.specificType.length > 0,
      ...(privateContext && NATIVE_EXCEPTION_NAMES.has(value.exception?.name) && typeof value.exception?.message === 'string' && value.exception.message
        ? { safeErrorText: sanitizeNativeErrorMessage(value.exception.message, { ...privateContext, specificType: value.exception.specificType }) } : {}) } : {}) };
}
export function nativeInvocationDiagnostic(error, stage, nativeExceptions, privateContext) {
  // Fixed classifications plus bounded, redacted text only for a proven SDK
  // exception. No raw stack, response, specificType or private value is copied.
  const family = nativeExceptionFamily(error, nativeExceptions);
  return { stage: INVOCATION_STAGES.has(stage) ? stage : 'unknown',
    exceptionClass: ERROR_CLASSES.has(error?.name) ? error.name : 'unknown', code: safeError(error),
    ...(family !== 'unknown' ? { nativeExceptionFamily: family } : {}),
    ...(NATIVE_ERROR_CODES.has(error?.errorCode) ? { nativeErrorCode: error.errorCode } : {}),
    ...(privateContext && family !== 'unknown' && typeof error?.message === 'string' && error.message
      ? { safeErrorText: sanitizeNativeErrorMessage(error.message, { ...privateContext, specificType: error.specificType }) } : {}) };
}

export function checkOdcNativeScreenPermissions(controller, report, nativeExceptions) {
  if (!controller) return;
  try { controller.constructor.checkPermissions(); report.permissionCheck = true; }
  catch (error) {
    report.permissionCheck = false;
    report.permissionDiagnostic = nativeInvocationDiagnostic(error, 'permissions', nativeExceptions);
    fail('screen_permission_check_failed');
  }
}

export function validateOdcPublishedDefinition(definition, binding) {
  // applicationName is a display label (e.g. "Escala Viva"). The generated
  // homeModuleName is the technical route; both native GUIDs bind its identity.
  const key = keyToGuid(binding.moduleKey).toLowerCase();
  if (definition?.applicationKey?.toLowerCase() !== key || definition?.homeModuleKey?.toLowerCase() !== key ||
      definition?.homeModuleName !== binding.module || Number(definition?.appVersion) !== Number(binding.revision))
    fail('published_model_mismatch');
}

// These inputs are calculated by the original ScreenAction from its screen
// locals. A retained model may have changed since the previous scenario: read
// the native value again, without assigning the published default ourselves.
export function assertNativeScreenDerivedDefaults(prepared, { plan, screenModel, dataTypes, context, applied = false } = {}) {
  const proofs = (prepared.bindings ?? []).filter(binding => ['native-screen-local-default', 'native-screen-local-context'].includes(binding.originalDerived?.kind));
  for (const binding of proofs) {
    const proof = binding.originalDerived;
    const explicit = proof.kind === 'native-screen-local-context';
    if (proof.schema !== 'ssam-odc-original-derived-input/1' || proof.entryKey !== prepared.entry?.key || proof.targetKey !== prepared.action?.key ||
        proof.targetInput !== binding.targetInput || !plan?.screen || proof.ownerKey !== plan.screen.key || !['MobileScreen', 'WebScreen'].includes(proof.ownerKind) || !screenModel ||
        proof.evaluatedByDebugger !== false || proof.stateValidation !== 'native-screen-value-before-invoke' ||
        !/^[a-f0-9]{64}$/i.test(proof.sourceSha256 ?? '') || proof.sourceSha256.toLowerCase() !== prepared.sourceContract?.sha256?.toLowerCase() ||
        (!explicit && !/^[a-f0-9]{64}$/.test(proof.defaultValueSha256 ?? '')) || !/^[A-Za-z0-9_+]{22}$/.test(proof.variableKey ?? '') ||
        typeof proof.variableName !== 'string' || /password|credential|authorization|cookie|token|secret/i.test(proof.variableName) ||
        !['Integer', 'Text', 'Boolean'].includes(proof.dataType)) fail('screen_derived_default_unqualified');
    if ((!explicit && Object.hasOwn(context?.screen?.variables ?? {}, proof.variableName)) || Object.hasOwn(context?.screen?.inputs ?? {}, proof.variableName))
      fail('screen_derived_default_override');
    const attributes = screenModel.variables?.getAttributes?.();
    const matches = Array.isArray(attributes) ? attributes.filter(a => a.name === proof.variableName && /Var$/.test(a.attrName ?? '')) : [];
    if (matches.length !== 1 || typeof dataTypes?.[proof.dataType] !== 'number' || matches[0].dataType !== dataTypes[proof.dataType])
      fail('screen_derived_default_unqualified');
    if (explicit && (proof.explicitContext !== true || !Object.hasOwn(context?.screen?.variables ?? {}, proof.variableName)))
      fail('screen_context_input_missing');
    const expected = explicit ? context.screen.variables[proof.variableName] : undefined;
    const value = explicit && !applied ? expected : screenModel.variables[matches[0].attrName];
    const typed = proof.dataType === 'Integer' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      : typeof value === (proof.dataType === 'Boolean' ? 'boolean' : 'string');
    if (!typed || (explicit ? value !== expected : createHash('sha256').update(JSON.stringify(value)).digest('hex') !== proof.defaultValueSha256))
      fail('screen_derived_default_changed');
  }
  return { screenDefaultsVerified: proofs.length };
}

export function beginOdcNativeClientInvocation(dbg, trace, observers = {}) {
  if (typeof dbg?.startSession !== 'function' || typeof dbg?.endSession !== 'function') fail('client_debugger_session_unavailable');
  // The original SDK session selects DebuggerHttpClient for generated server
  // requests. It is required even when this invocation collects no client trace.
  dbg.startSession();
  const saved = {};
  if (trace !== 'none') for (const [key, observe] of Object.entries(observers)) {
    if (typeof dbg[key] !== 'function') continue;
    saved[key] = dbg[key];
    dbg[key] = function (...args) { try { observe(...args); } catch {} return saved[key].apply(this, args); };
  }
  return () => { for (const [key, fn] of Object.entries(saved)) dbg[key] = fn; dbg.endSession(); };
}

export async function createOdcNativeHost({ runtime, prepared, binding, operationId, sessionId, beforeRequest, fetchImpl = fetch, WebSocketImpl = WebSocket, privateEvidence, clientLocal } = {}) {
  if (typeof vm.SourceTextModule !== 'function') fail('vm_modules_required');
  const sources = readOdcRuntimeSources(runtime), plan = resolveOdcRuntimeEntry(prepared, runtime), ix = runtime.index;
  if (clientLocal && JSON.stringify(qualifyClientLocalRuntime(prepared, runtime, clientLocal.model)) !== JSON.stringify(clientLocal)) fail('client_local_worker_plan_mismatch');
  const networkBarrier = createClientLocalNetworkBarrier(!!clientLocal);
  const endpoints = odcNativeEndpoints(binding), modules = new Map(), controllers = [], pending = new Set(), attempted = new Set();
  const dom = new JSDOM(sources['index.html'], { url: endpoints.appUrl, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const window = dom.window, context = dom.getInternalVMContext(), abort = new AbortController();
  let core, services, container, nativeClient, nativeAuth, nativeExceptions, session, descriptor, controller, moduleController, model, screenModel, screenController, disposed = false, scenario, leaseTimer;
  let privateValues = [], requestNumber = 0, syncAttempted = false, successfulMetadataRequests = 0;
  let inspection, inspector, inspectionOptions;
  const report = { browser: false, sourceBodiesChanged: false, authenticated: false, identityMatches: false, permissionCheck: false,
    nativeAuthenticationSyncAccepted: false, cleanupConfirmed: false, clientTrace: true, requestIsolationProved: false, metadataRequests: [], metadataErrors: [], metadataFailures: [], nativeResponses: [],
    lifecycle: plan.lifecycle, mounted: false, nativeIdentityChecks: 0, serverUserContextObserved: false, producerRolesObserved: false,
    scenarioState: 'native-model-retained; context overrides only explicitly supplied attributes' };
  const transport = createOdcNativeTransport({ endpoints,
    fetchImpl: (...args) => { networkBarrier.check('transport'); return fetchImpl(...args); },
    WebSocketImpl: class extends WebSocketImpl { constructor(...args) { networkBarrier.check('transport'); super(...args); } },
    privateEvidence: privateEvidence ?? createOdcNativeEvidence({ operationId, binding, sessionId }),
    beforeActionRequest: async info => beforeRequest ? await beforeRequest(info) === true : false });
  Object.assign(window, { TextEncoder, TextDecoder, AbortSignal, AbortController, Headers, Request, Response, structuredClone });
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  Object.defineProperty(window.navigator, 'onLine', { get: () => successfulMetadataRequests > 0, configurable: true });
  window.OutSystemsApp = { basePath: endpoints.base };
  window.fetch = (...args) => { networkBarrier.check('transport'); return transport.fetch(...args); };
  window.WebSocket = class extends transport.WebSocket { constructor(...args) { networkBarrier.check('transport'); super(...args); } };
  window.XMLHttpRequest = class { constructor() { fail('xhr_not_supported'); } };
  window.navigator.sendBeacon = () => false;
  function check(auth = false) {
    if (disposed) fail('host_disposed');
    if (auth && (!session || Date.parse(descriptor.expiresAt) <= Date.now() || Date.parse(session.expiresAt) <= Date.now())) fail('app_session_expired');
  }
  function checkNativeIdentity() {
    check(true);
    const auth = shape('builtinLogin', 'isAuthenticated', 'getUserId');
    if (auth.isAuthenticated() !== true || auth.getUserId() !== session.userKey) fail('native_identity_mismatch');
    report.nativeIdentityChecks++;
  }
  function moduleFor(file) {
    if (modules.has(file)) return modules.get(file);
    if (!Object.hasOwn(sources, file) || !file.endsWith('.js')) fail('dependency_unavailable');
    const metadata = ix.chunks[file], locals = [...new Set([...(metadata?.topLevel ?? []), ...(metadata?.imports ?? []).flatMap(i => i.names.map(n => n.local))])];
    if (locals.some(n => !/^[A-Za-z_$][\w$]*$/.test(n))) fail('export_alias_invalid');
    // Appended exports expose native factories to the host; no function body is rewritten.
    const text = file === ix.bootstrap.file ? ix.initModule : sources[file] + (locals.length ? '\nexport {' + locals.map((n, i) => `${n} as __ssam_${i}`).join(',') + '};\n' : '');
    const module = new vm.SourceTextModule(text, { context, identifier: file,
      initializeImportMeta: meta => { meta.url = new URL(endpoints.base + 'scripts/' + file, endpoints.origin).href; },
      importModuleDynamically: async specifier => { const child = moduleFor(relative(specifier)); await evaluate(child); return child; } });
    modules.set(file, module); return module;
  }
  function relative(specifier) { if (!/^\.\/_os(?:chunk|bundle)-[A-Za-z0-9_.+]+\.js$/.test(specifier)) fail('dependency_scope_invalid'); return specifier.slice(2); }
  async function evaluate(module) {
    if (module.status === 'unlinked') await module.link(specifier => moduleFor(relative(specifier)));
    if (module.status === 'linked') await module.evaluate({ timeout: 10000 });
    if (module.status === 'errored') throw module.error;
  }
  async function load(file) { const module = moduleFor(file); await evaluate(module); return module.namespace; }
  async function local(file, name) {
    const metadata = ix.chunks[file], names = [...new Set([...(metadata?.topLevel ?? []), ...(metadata?.imports ?? []).flatMap(i => i.names.map(n => n.local))])];
    const at = names.indexOf(name); if (at < 0) fail('native_factory_unavailable');
    return (await load(file))['__ssam_' + at];
  }
  const objects = () => [...new Set(Object.values(core))];
  function shape(...keys) { const found = objects().filter(v => v && keys.every(k => k in Object(v))); if (found.length !== 1) fail('sdk_shape_unresolved'); return found[0]; }
  function nativeFunction(name) { const found = objects().filter(v => typeof v === 'function' && v.name === name); if (found.length !== 1) fail('sdk_initializer_unresolved'); return found[0]; }
  function track(promise) { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; }
  async function settle() { await new Promise(r => setImmediate(r)); while (pending.size) await Promise.all([...pending]); check(); }
  async function metadataRequest(method, input) {
    networkBarrier.check('metadata');
    check(); const base = input.baseURL ? new URL(input.baseURL, endpoints.appUrl) : new URL(endpoints.appUrl);
    const relativeUrl = input.baseURL && !/^https?:\/\//.test(input.url) ? input.url.replace(/^\//, '') : input.url;
    const url = new URL(relativeUrl, base.href.endsWith('/') ? base : base.href + '/');
    if (url.origin !== endpoints.origin || url.username || url.password || url.hash) fail('metadata_scope_invalid');
    if (input.params) for (const [key, value] of Object.entries(input.params)) url.searchParams.set(key, value);
    const sync = method === 'POST' && url.pathname === endpoints.sync;
    const identity = ['/api/user-information/v1/profiles/me', '/api/user-information/v1/claims'].includes(url.pathname);
    const allowed = [endpoints.authConfigs, endpoints.clientSettings, endpoints.versionInfo, endpoints.moduleInfo, '/identity/.well-known/openid-configuration'].includes(url.pathname) || identity || /^\/auth\/realms\/[a-f0-9-]+\/protocol\/openid-connect\/certs$/.test(url.pathname);
    if (method === 'GET' ? !allowed : !sync || syncAttempted || !session || input.payload !== undefined || input.body !== undefined) fail('metadata_request_refused');
    report.metadataRequests.push({ method, path: url.pathname });
    const headers = { Accept: 'application/json' };
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (key.toLowerCase() !== 'authorization' || !session || value !== 'Bearer ' + session.accessToken) fail('metadata_auth_mismatch');
      headers.Authorization = value;
    }
    if ((sync || identity) && !headers.Authorization) fail('metadata_auth_required');
    if (sync) { syncAttempted = true; report.authenticationSyncUncertain = true; }
    let phase = 'fetch', status;
    try {
      const response = await fetchImpl(url, { method, headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
      status = response.status;
      if (!response.ok || response.redirected) fail('metadata_request_failed');
      successfulMetadataRequests++;
      phase = 'body';
      const text = await response.text(); if (text.length > 8 * 1024 * 1024) fail('metadata_size_limit');
      phase = 'json'; const data = text && !sync ? JSON.parse(text) : undefined;
      if (url.pathname === endpoints.versionInfo && data?.versionToken !== runtime.moduleVersion) fail('publication_changed');
      if (url.pathname === endpoints.moduleInfo && data?.manifest?.versionToken !== runtime.moduleVersion) fail('publication_changed');
      if (sync) { report.nativeAuthenticationSyncAccepted = true; report.authenticationSyncUncertain = false; }
      phase = 'handler'; input.responseHandler?.({ data, responseHeaders: Object.fromEntries(response.headers.entries()) }); return data;
    } catch (error) {
      report.metadataFailures.push({ method, path: url.pathname, phase, ...(status === undefined ? {} : { status }),
        type: ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
        ...(typeof error?.cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,50}$/.test(error.cause.code) ? { cause: error.cause.code } : {}) });
      if (phase === 'fetch' && ['EACCES', 'EPERM'].includes(error?.cause?.code)) fail('metadata_network_denied');
      throw error;
    }
  }
  async function actionRequest(input) {
    networkBarrier.check('action');
    checkNativeIdentity(); if (!scenario) fail('scenario_required');
    const url = new URL(input.url, endpoints.appUrl);
    const expected = url.pathname.startsWith(endpoints.base) ? plan.endpoints[url.pathname.slice(endpoints.base.length)] : null;
    if (url.origin !== endpoints.origin || !expected || url.search || input.payload?.versionInfo?.apiVersion !== expected) fail('action_scope_mismatch');
    if (input.payload?.versionInfo?.moduleVersion !== runtime.moduleVersion) fail('publication_changed');
    const probeId = scenario.id + '-' + (++requestNumber);
    if (requestNumber > 200) fail('request_limit');
    await transport.beginProbe({ probeId, path: url.pathname, serializedBody: JSON.stringify(input.payload), headers: input.headers,
      timeoutSeconds: Math.min(input.timeout ?? 90, scenario.timeoutSeconds), bindingSessionId: session.binding.sessionId });
    try {
      const result = await transport.awaitNativeResult(nativeClient.post(input));
      scenario.nativeResponse = nativeResponseDiagnostic(result, { privateValues, userKey: session?.userKey });
      report.nativeResponses.push({ requestNumber, ...scenario.nativeResponse,
        transportComparison: transport.compareNativeResponse(result),
        ...(scenario.nativeResponse.shape === 'native-success' ? { dataShape: nativeOutputShape(result.data, privateValues) } : {}) });
      // Keep a bounded private snapshot only for the original Data Action's own
      // response. The SDK may mutate its input during conversion; compare later
      // against the original converted output without intercepting that code.
      if (plan.member.call?.kind === 'data-action' && url.pathname === endpoints.base + plan.member.call.endpoint &&
          scenario.nativeResponse.shape === 'native-success') {
        scenario.outputResponseCount = (scenario.outputResponseCount ?? 0) + 1;
        scenario.outputWire = null;
        scenario.outputComparisonOmitted = 'multiple-native-responses';
        if (scenario.outputResponseCount === 1) {
          scenario.outputComparisonOmitted = 'wire-budget';
          try {
            if (Buffer.byteLength(JSON.stringify(result.data)) <= 1024 * 1024) {
              scenario.outputWire = { data: structuredClone(result.data), requestNumber };
              scenario.outputComparisonOmitted = null;
            }
          } catch { scenario.outputComparisonOmitted = 'wire-snapshot-unavailable'; }
        }
      }
      if (result?.shouldRefreshToken || result?.versionInfo?.hasModuleVersionChanged || result?.versionInfo?.hasApiVersionChanged) fail('response_version_changed');
      transport.finishProbe({ completed: true }); return result;
    } catch (error) { transport.finishProbe(); throw error; }
  }
  async function instance(view, parent) {
    const factory = await local(view.chunk, view.modelFactory), cf = await local(view.chunk, view.controllerFactory);
    const WidgetIdService = shape('WidgetIdService').WidgetIdService;
    const m = factory.create({ viewName: parent ? plan.screen.displayName : view.displayName, navigatedFromHistory: false, viewWasRestoredFromCache: false });
    const c = cf.create(m, new WidgetIdService(parent?.idService ?? null)); controllers.push(c); return { model: m, controller: c };
  }
  function project(value, depth = 0, complete = false) {
    if (depth > (complete ? 64 : 8)) return complete ? { omitted: true, reason: 'depth_budget', nativeInspectionRequired: true } : '[depth-limit]';
    if (value === null || value === undefined) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value.getAttributes === 'function') return Object.fromEntries(value.getAttributes().slice(0, complete ? undefined : 100).map(a => [a.name, project(value[a.attrName], depth + 1, complete)]));
    if (typeof value.getItem === 'function' && Number.isInteger(value.length)) return Array.from({ length: complete ? value.length : Math.min(value.length, 1000) }, (_, i) => project(value.getItem(i), depth + 1, complete));
    if (value.constructor?.name?.match(/Decimal|LongInteger|DateTime/)) return String(value);
    if (Array.isArray(value)) return value.slice(0, complete ? undefined : 1000).map(v => project(v, depth + 1, complete));
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => (complete || !k.startsWith('_')) && typeof v !== 'function').slice(0, complete ? undefined : 100).map(([k, v]) => [k, project(v, depth + 1, complete)]));
  }
  const publicValue = value => publicWrapperBody(project(value), privateValues);
  function argumentsFor(inputs) {
    const args = new Array(plan.inputs.length), conv = shape('ServerDataConverter').ServerDataConverter, types = shape('DataTypes', 'GenericRecord');
    for (const p of plan.inputs) {
      const value = inputs[p.name];
      if (!value || value.omitted) continue; // The original generated function applies its own defaults.
      const dataType = p.dataType?.replaceAll(' ', ''), wire = value.value;
      if (['Record', 'RecordList'].includes(dataType)) {
        const owner = moduleController ?? controller, Group = owner?.constructor?.getVariableGroupType?.(plan.member.varsGroup);
        const group = Group && new Group(), attribute = group?.getAttributes?.().find(a => a.name === p.name);
        const Class = attribute && group[attribute.attrName]?.constructor;
        if (!Class) fail('complex_input_type_unresolved');
        args[p.position] = conv.from(dataType === 'RecordList' ? { List: wire ?? [] } : wire ?? {}, Class);
      } else {
        if (types.DataTypes[dataType] === undefined) fail('input_type_unresolved');
        args[p.position] = conv.from(wire, types.DataTypes[dataType]);
      }
    }
    return args;
  }
  function contextFor(context) {
    return prepareOdcNativeContext(context, { screenModel,
      blockModel: plan.view && plan.screen && plan.view.key !== plan.screen.key ? model : undefined,
      dataTypes: shape('DataTypes', 'GenericRecord').DataTypes, converter: shape('ServerDataConverter').ServerDataConverter });
  }
  function verifyScreenDefaults(suppliedContext, applied = false) {
    return assertNativeScreenDerivedDefaults(prepared, { plan, screenModel, context: suppliedContext, applied,
      dataTypes: shape('DataTypes', 'GenericRecord').DataTypes });
  }
  async function dispose() {
    if (disposed) return { completed: report.cleanupConfirmed }; disposed = true; clearTimeout(leaseTimer); abort.abort();
    if (scenario) scenario.outputWire = null;
    const privateCleanup=inspection?.dispose()??{completed:true,pending:0};report.privateInspectionCleanup=privateCleanup;inspector?.close();
    let complete = privateCleanup.completed; const attempt = async f => { try { await f(); } catch { complete = false; } };
    await attempt(() => transport.dispose());
    await attempt(() => nativeAuth?.clearAuthenticationData());
    for (const c of controllers.reverse()) await attempt(() => c.dispose?.());
    await attempt(() => window.localStorage.clear()); await attempt(() => window.sessionStorage.clear()); await attempt(() => window.close());
    if (session) for (const key of ['accessToken', 'idToken', 'refreshToken']) session[key] = '';
    session = undefined; privateValues.fill(''); privateValues = []; modules.clear();
    report.cleanupConfirmed = complete && !transport.receipt().longPollingCleanupUncertain;
    return { completed: report.cleanupConfirmed };
  }
  try {
    const coreFiles = Object.entries(ix.chunks).filter(([, c]) => Object.values(c.keepNames).includes('WidgetIdService')).map(([file]) => file);
    if (coreFiles.length !== 1) fail('core_module_unresolved'); core = await load(coreFiles[0]);
    const exceptionFamilies = [...new Set(objects().map(value => value?.Exceptions).filter(value =>
      typeof value?.Exception === 'function' && typeof value?.ServerException === 'function' && typeof value?.UserException === 'function'))];
    if (exceptionFamilies.length === 1) nativeExceptions = exceptionFamilies[0];
    const boot = await load(ix.bootstrap.file); container = boot.__ssamContainer;
    validateOdcPublishedDefinition(boot.__ssamDefinition, binding);
    services = shape('HttpClient', 'DebuggerHttpClient', 'AuthConfigsManager');
    await nativeFunction('runPreInitialization')(container, { applicationDefinition: boot.__ssamDefinition });
    nativeClient = container.resolve(services.DebuggerHttpClient);
    container.resolve(services.InstrumentationFactory)?.dispose?.(); container.unregister(services.InstrumentationFactory); container.unregister(services.LoggerHttpClient);
    await nativeFunction('useBaseApplication')(container);
    const readMetadata = (method, input) => track(metadataRequest(method, input).catch(error => { report.metadataErrors.push(safeError(error)); throw error; }));
    const http = { get: input => readMetadata('GET', input), post: input => readMetadata('POST', input) };
    for (const key of [services.HttpClient, services.UnauthenticatedHttpClient, services.NonDebuggerHttpClient]) container.register(key, () => http);
    container.register(services.DebuggerHttpClient, () => ({ get: http.get, post: input => track(actionRequest(input)) }));
    await nativeFunction('useSettingsAndAuthConfigs')(container);
    // The SDK tolerates failed metadata reads by falling back to its browser
    // cache. A fresh headless host has no such cache: report the actual failure
    // before a missing provider/manifest disguises a denied network request.
    if (report.metadataErrors.includes('debug_odc_native_metadata_network_denied')) fail('metadata_network_denied');
    if (report.metadataErrors.length) fail('metadata_initialization_failed');
    await nativeFunction('useVersionsManager')();
    if (plan.screen) { const s = await instance(plan.screen); screenController = s.controller; screenModel = s.model; screenController.setAsActiveScreen();
      if (plan.view.key === plan.screen.key) { model = s.model; controller = s.controller; } }
    if (plan.view && !controller) ({ model, controller } = await instance(plan.view, screenController));
    if (!controller) {
      controller = await local(plan.member.chunk, plan.member.holder.local);
      if (plan.member.moduleController) moduleController = await local(plan.member.chunk, plan.member.moduleController);
    }
    plan.outputs = nativeDataActionOutputs(plan, model);
    const contextOwner = moduleController ?? controller;
    if (plan.lifecycle && (typeof controller?.[plan.lifecycle.handler] !== 'function' || typeof controller?.fireEvent !== 'function')) fail('lifecycle_handler_unavailable');
    report.nativeTimeoutConfigurable = typeof contextOwner?.callContext === 'function' && typeof contextOwner.callContext()?.withTimeout === 'function';
    if (!report.nativeTimeoutConfigurable) fail('native_timeout_unavailable');
    await settle();
    report.nativeAuthProviderAvailable = !!container.resolve(services.AuthConfigsManager).readAuthConfigs('cognito', { suppressExternalWarnings: true })?.[0];
    if (!report.nativeAuthProviderAvailable) fail('auth_provider_unavailable');
  } catch (error) { await dispose(); error.diagnostics = report; throw error; }
  return {
    configureServerInspection(options) {
      check(true);
      if (!report.authenticated || !report.identityMatches || scenario || attempted.size) fail('inspection_not_ready');
      return transport.configureServerInspection(options);
    },
    configureInspection(options) {
      if (inspection || scenario) fail('inspection_already_configured');
      const enableOptions = clientInspectionEnableOptions(options);
      inspection = createNativeClientInspection({ debuggerObject: window.OutSystemsDebugger, globalObject: window,
        binaryType: shape('DataTypes','GenericRecord').BinaryData,
        platform: 'odc', modules: options.modules, variables: options.variables,
        privateChannel:createPrivateInspectionChannel({binding:descriptor.binding,sources:options.modules,
          expiresAt:new Date(Math.min(Date.parse(descriptor.expiresAt),Date.now()+options.leaseMs)).toISOString()}),
        redact: value => redactNativeClientValue(value, privateValues) });
      inspectionOptions = enableOptions; inspector = openNativeClientInspector();
      return { url: inspector.url, helperName: inspection.helperName,privateConsumerCapability:inspection.privateConsumerCapability };
    },
    receipt: () => ({ ...report, transport: transport.receipt(), ...(clientLocal ? { clientLocal: networkBarrier.receipt() } : {}) }),
    dispose,
    validateScenarios(calls) { for (const call of calls) { argumentsFor(call.inputs); contextFor(call.context); verifyScreenDefaults(call.context); } return { scenariosValidated: calls.length }; },
    async authenticate(privateSession, appUser, secrets) {
      check(); if (session || !sameAppUserTarget(privateSession?.binding, appUser?.binding) || privateSession.binding.runtimeUrl !== endpoints.appUrl) fail('app_user_scope_mismatch');
      session = privateSession; descriptor = appUser; privateValues = secrets; check(true);
      leaseTimer = setTimeout(() => { void dispose(); }, Math.min(Date.parse(session.expiresAt), Date.parse(descriptor.expiresAt)) - Date.now()); leaseTimer.unref?.();
      const configs = container.resolve(services.AuthConfigsManager), provider = configs.readAuthConfigs('cognito', { suppressExternalWarnings: true })?.[0];
      if (!provider) fail('native_auth_provider_unavailable');
      const factory = container.resolve(services.Auth); nativeAuth = factory.getInstance('external', { identityProvider: provider.kc_hint ?? provider.type, scope: 'openid' });
      const nonce = JSON.parse(Buffer.from(session.idToken.split('.')[1], 'base64url')).nonce;
      if (typeof nonce !== 'string' || !nonce) fail('native_auth_nonce_missing');
      await nativeAuth.storeUserInfo({ token_type: 'Bearer', access_token: session.accessToken, id_token: session.idToken, refresh_token: session.refreshToken }, { nonce, validateNonce: true });
      await settle(); const auth = shape('builtinLogin', 'isAuthenticated', 'getUserId');
      report.authenticated = auth.isAuthenticated() === true; report.identityMatches = auth.getUserId() === session.userKey;
      if (!report.authenticated || !report.identityMatches || !report.nativeAuthenticationSyncAccepted || await factory.getInstance().getValidAccessToken() !== 'Bearer ' + session.accessToken) fail('native_identity_mismatch');
      checkOdcNativeScreenPermissions(screenController, report, nativeExceptions);
      transport.bindAuthenticatedLease({ binding: session.binding, expiresAt: new Date(Math.min(Date.parse(session.expiresAt), Date.parse(descriptor.expiresAt))).toISOString(), accessToken: session.accessToken, userKey: session.userKey });
      return { authenticated: true, identityMatches: true, permissionCheck: report.permissionCheck };
    },
    async invoke({ id, name, inputs, context: suppliedContext, trace = 'none', timeoutSeconds = 90 }) {
      check(true); if (scenario || attempted.has(id) || transport.receipt().uncertain) fail('scenario_already_attempted');
      // The freeze starts before trace setup and remains through disposal. Only
      // original authentication/metadata initialization may use the network.
      networkBarrier.enter();
      attempted.add(id); scenario = { id, timeoutSeconds }; const started = performance.now(), visits = [], frames = new Map();
      const dbg = window.OutSystemsDebugger;
      const endClientInvocation = beginOdcNativeClientInvocation(dbg, trace, {
        push: (key, module, action, kind, ccid, bag) => { if (!frames.has(ccid)) frames.set(ccid, []); frames.get(ccid).push({ functionKey: key.split(':')[1], module, action, bag }); },
        pop: (_, ccid) => frames.get(ccid)?.pop(),
        handleBreakpoint: (key, ccid) => { const frame = frames.get(ccid)?.at(-1); if (visits.length >= 2000) return;
          visits.push({ nodeKey: key.split(':')[1], functionKey: frame?.functionKey, action: frame?.action, depth: frames.get(ccid)?.length ?? 0,
            ...(trace === 'full' && frame ? { values: publicValue(Object.fromEntries(Object.entries(frame.bag ?? {}).filter(([k]) => !['idService', 'callContext'].includes(k)))) } : {}) }); },
      });
      if (inspection) inspection.enable(inspectionOptions);
      let invocationStage = 'identity-before-invoke';
      try {
        checkNativeIdentity();
        invocationStage = 'permissions';
        if (screenController) screenController.constructor.checkPermissions();
        invocationStage = 'native-context';
        verifyScreenDefaults(suppliedContext);
        const nativeContext = contextFor(suppliedContext); nativeContext.apply();
        verifyScreenDefaults(suppliedContext, true);
        invocationStage = 'arguments';
        const args = argumentsFor(inputs);
        invocationStage = 'timeout-context';
        const contextOwner = moduleController ?? controller;
        if (contextOwner?.callContext) {
          const callContext = contextOwner.callContext();
          if (typeof callContext.withTimeout !== 'function') fail('native_timeout_unavailable');
          args.push(callContext.withTimeout(timeoutSeconds));
        }
        // fireEvent preserves the runtime's event error classification. Bind the
        // original handler to our typed arguments/context; no action body is rewritten.
        window.__ssamInvoke = () => plan.lifecycle
          ? controller.fireEvent(controller[plan.lifecycle.handler].bind(controller, ...args))
          : typeof controller === 'function' ? controller(...args) : controller[plan.member.holder.name](...args);
        invocationStage = 'native-invocation';
        const value = await vm.runInContext('__ssamInvoke()', context, { timeout: timeoutSeconds * 1000 });
        invocationStage = 'settle';
        await settle();
        invocationStage = 'identity-after-invoke';
        checkNativeIdentity();
        invocationStage = 'outputs';
        const output = plan.member.dataActVar ? model.variables[plan.member.dataActVar] : value;
        const projectedOutputs = plan.outputs.length ? Object.fromEntries(plan.outputs.map(p => [p.wire ?? p.name, project(output?.[p.attrName], 0, true)])) : project(output, 0, true);
        let outputComparison = scenario.outputComparisonOmitted ? {
          schema: 'ssam-native-output-comparison/1', complete: false, representationEqual: false,
          semanticEqualityAssessed: false, reason: scenario.outputComparisonOmitted,
        } : undefined;
        if (scenario.outputWire && plan.outputs.length) {
          const wire = scenario.outputWire;
          const selected = Object.fromEntries(plan.outputs.flatMap(p => {
            const key = p.wire ?? p.name;
            return wire.data && Object.hasOwn(wire.data, key) ? [[key, wire.data[key]]] : [];
          }));
          outputComparison = { ...nativeOutputComparison(selected, projectedOutputs), requestNumber: wire.requestNumber };
          report.nativeResponses.find(r => r.requestNumber === wire.requestNumber).outputComparison = outputComparison;
          scenario.outputWire = null;
        }
        const outputs = nativeWireOutput(projectedOutputs, privateValues, { unwrapLists: false });
        return { name, ok: true, outputs, visits, context: nativeContext.receipt, lifecycle: plan.lifecycle, mounted: false,
          ...(outputComparison ? { outputComparison } : {}),
          ...(clientLocal ? { clientLocal: networkBarrier.receipt() } : {}),
          nativeUserIdentityPreserved: true, serverUserContextObserved: false, producerRolesObserved: false,
          durationMs: Math.round(performance.now() - started), uncertain: transport.receipt().uncertain };
      } catch (error) {
        return { name, ok: false, ...(KNOWN_EXCEPTIONS.has(error?.name) ? { exception: { type: error.name, message: publicWrapperBody(error.message, privateValues) } } : { error: safeError(error) }),
          diagnostic: { ...nativeInvocationDiagnostic(error, invocationStage, nativeExceptions, { privateValues, userKey: session?.userKey }),
            ...(scenario.nativeResponse ? { nativeResponse: scenario.nativeResponse } : {}) },
          ...(clientLocal ? { clientLocal: networkBarrier.receipt() } : {}),
          visits, durationMs: Math.round(performance.now() - started), uncertain: transport.receipt().uncertain };
      } finally { report.privateInspectionCleanup=inspection?.finish()??{completed:true,pending:0}; delete window.__ssamInvoke; endClientInvocation(); scenario = null; }
    },
  };
}

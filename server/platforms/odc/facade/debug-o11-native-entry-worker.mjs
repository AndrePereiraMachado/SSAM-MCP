// Private child: loads hash-pinned original AMD code; stdout is a small, typed RPC protocol.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appUserBinding, sameAppUserTarget, privateAppUserVault } from './debug-app-user.mjs';
import { validatePrivateDescriptor } from './debug-app-user-worker.mjs';
import { readO11NativeEntryContract, o11NativePublicCode, o11NativePublicTarget, o11NativeDirectory } from './debug-o11-native-entry.mjs';
import { applyO11Context, invokeO11Lifecycle, trackO11ClientProxies, settleO11ClientProxies } from './debug-o11-native-context.mjs';
import { createNativeClientInspection, openNativeClientInspector, redactNativeClientValue, clientInspectionEnableOptions } from './debug-native-client-inspection.mjs';
import { createPrivateInspectionChannel } from './debug-private-inspection.mjs';
import { isO11NativeSuspensionCheck } from './debug-o11-suspended-request.mjs';
import { nativeWireOutput } from './debug-native-wire-output.mjs';
import { o11InspectionDeadline, o11InvocationBudget, o11NativeInspectionTimeout } from './debug-o11-inspection-deadline.mjs';
import { O11_NATIVE_ENVELOPE_BYTES } from './debug-o11-native-abi.mjs';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const publicCode = error => o11NativePublicCode(error?.message, 'debug_o11_native_execution_failed');
const errorType = error => ['TypeError', 'SyntaxError', 'ReferenceError', 'NotRegisteredException', 'InvalidLoginException',
  'CommunicationException', 'InvalidDataException'].includes(error?.name) ? error.name : 'Unknown';
const sessions = new WeakMap();
const diagnostics = (state, error) => {
  state.report.diagnostics.errorType = errorType(error);
  // Only fixed global names and coordinates in a pinned asset are public; never the original message/stack.
  const missing = /^(document|navigator|performance|OutSystemsDebugger|window|global|location) is not defined$/.exec(error?.message ?? '');
  if (missing) state.report.diagnostics.missingRuntimeGlobal = missing[1];
  for (const line of typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 12) : []) {
    const match = /(?:\(|\s)([A-Za-z_][A-Za-z0-9_.-]*\.js):(\d{1,7}):(\d{1,7})\)?$/.exec(line);
    if (match && state.policy.assets.some(asset => asset.name === match[1])) {
      state.report.diagnostics.source = { asset: match[1], line: Number(match[2]), column: Number(match[3]) }; break;
    }
  }
};

export async function prepareOriginalO11Entry(input, { fetchImpl = fetch, cookieJar, now = Date.now, beforeRequest } = {}) {
  o11NativeDirectory(input.root, input.directory);
  if (input.target.host && input.target.host !== new URL(input.target.runtimeUrl).hostname) fail('debug_o11_native_target_mismatch');
  let target = o11NativePublicTarget(input.target);
  input = { ...input, sourceContract: { path: input.sourceContract?.path, sha256: input.sourceContract?.sha256 } };
  const policy = readO11NativeEntryContract(input.sourceContract, target, input.action);
  target = policy.target;
  if (!process.execArgv.includes('--experimental-webstorage') || !globalThis.sessionStorage || globalThis.sessionStorage.length)
    fail('debug_o11_native_memory_storage_required');
  if (target.host && target.host !== new URL(target.runtimeUrl).hostname) fail('debug_o11_native_target_mismatch');
  if (!/^[a-f0-9]{32}$/.test(input.sessionId ?? '')) fail('debug_o11_native_session_invalid');
  const { CookieJar } = cookieJar ? {} : require('tough-cookie');
  const v2 = policy.version === 2;
  const publicEntry = v2
    ? { selector: input.action, kind: policy.entry.kind, actionKey: policy.entry.actionKey ?? null, endpoint: policy.entry.endpoint ?? null,
        apiVersion: policy.entry.apiVersion ?? null, viewName: policy.entry.viewName ?? null, method: policy.entry.method,
        inputs: policy.entry.inputs.map(i => ({ name: i.name, dataType: i.dataType })), outputs: policy.entry.outputs.map(o => ({ name: o.name, dataType: o.dataType })),
        ...(policy.entry.lifecycle ? { lifecycle: { ...policy.entry.lifecycle, mounted: false } } : {}) }
    : { selector: input.action, actionKey: policy.entry.actionKey, endpoint: policy.entry.endpoint, apiVersion: policy.entry.apiVersion,
        viewName: policy.entry.viewName, inputsCount: 0, outputs: policy.entry.outputs.map(o => ({ name: o.name, type: o.type })) };
  const state = { input, policy, target, fetchImpl, now, beforeRequest, closed: false, armed: false, authenticating: false, v2, postSeq: 0,
    redact: [], scenario: null,
    jar: cookieJar ?? new CookieJar(undefined, { rejectPublicSuffixes: true, prefixSecurity: 'strict', allowSecureOnLocal: false }),
    requests: new Set(), requestTokens: new Set(), timers: new Set(), timerCompletions: new Map(), pendingActions: new Set(), controllers: [], credentials: undefined, userId: undefined, descriptor: undefined,
    markerPaths: {},
    report: { schema: 'ssam-o11-native-entry-receipt/1', ok: false, prepared: false, phase: 'preparing', browser: false,
      target, sourceContract: input.sourceContract, sessionId: input.sessionId, entry: publicEntry,
      originalLoginController: false, publishedAbiValidated: false, sourceAssetsVerified: 0,
      loginSubmitted: false, loginAnswered: false, loginSubmittedCount: 0, loginAnsweredCount: 0, loginUncertain: false,
      authenticated: false, nativeCheckRegisteredPassed: false, rolesLoadedFromServer: false,
      requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false, requestEnvelopeVerified: false,
      nativeClientRequestBound: false, userRequestIsolationProved: false, serverTraceProved: false,
      memoryCleared: false, nativeContextReferencesReleased: false, requests: 0, outputs: null,
      diagnostics: { phase: 'prepare', errorType: 'None' } } };
  fs.mkdirSync(input.directory, { recursive: true });
  const preparationPath = path.join(input.directory, 'native-entry-preparation.json');
  let preparationFd;
  try { preparationFd = fs.openSync(preparationPath, 'wx'); } catch { fail('debug_o11_native_preparation_already_reserved'); }
  try { fs.writeFileSync(preparationFd, JSON.stringify({ schema: 'ssam-o11-native-entry-preparation/1',
    sessionId: input.sessionId, sourceContractSha256: input.sourceContract.sha256 })); fs.fsyncSync(preparationFd); }
  finally { fs.closeSync(preparationFd); }
  state.receiptPath = path.join(input.directory, 'native-entry-receipt.json');
  const operation = path.join(input.directory, input.sessionId);
  state.markerPaths.login = operation + '.login-attempt.json'; state.markerPaths.entry = operation + '.entry-attempt.json';
  const persist = () => fs.writeFileSync(state.receiptPath, JSON.stringify(state.report, null, 2));
  const current = () => {
    if (state.closed) fail('debug_o11_native_closed');
    if (state.descriptor && now() >= Date.parse(state.descriptor.expiresAt)) fail('debug_o11_native_expired');
    if (state.armed && state.serverInspectionDeadline !== undefined && now() >= state.serverInspectionDeadline) fail('debug_o11_native_expired');
  };
  const reserve = kind => {
    const file = state.markerPaths[kind];
    let fd; try { fd = fs.openSync(file, 'wx'); } catch { fail('debug_o11_native_already_submitted'); }
    try { fs.writeFileSync(fd, JSON.stringify({ sessionId: input.sessionId, kind, sourceContractSha256: input.sourceContract.sha256 })); }
    finally { fs.closeSync(fd); }
    if (kind === 'login') { state.report.loginSubmitted = true; state.report.loginSubmittedCount = 1; }
    else state.report.requestSubmittedCount = 1;
    persist();
  };
  const request = async (method, inputUrl, { body, headers = {}, signal, timeoutMs = 15000 } = {}) => {
    current();
    const url = new URL(inputUrl, target.runtimeUrl), origin = new URL(target.runtimeUrl).origin;
    if (url.origin !== origin || url.username || url.password || url.hash) fail('debug_o11_native_request_denied');
    const asset = policy.assets.find(a => a.urlPath === url.pathname && a.query === url.search);
    const manifest = url.pathname === '/' + target.module + '/moduleservices/moduleinfo' && /^\?\d{13}$/.test(url.search);
    const roles = url.pathname === '/' + target.module + '/moduleservices/roles' && /^\?\d{13}$/.test(url.search);
    const suspension = state.armed && state.report.authenticated && isO11NativeSuspensionCheck(method, url, target, state.requestTokens);
    const login = method === 'POST' && state.authenticating && url.pathname === policy.login.endpoint && !url.search;
    const entry = method === 'POST' && state.armed && !url.search &&
      (v2 ? policy.entry.endpoints.includes(url.pathname) : url.pathname === policy.entry.endpoint);
    if (!(method === 'GET' && (asset || manifest || roles || suspension) || login || entry) || ++state.report.requests > (v2 ? 1500 : 100))
      fail('debug_o11_native_request_denied');
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!['accept', 'content-type', 'x-csrftoken', 'outsystems-request-token', 'outsystems-ccid', 'outsystems-dbg-stop', 'outsystems-dbg-bkp'].includes(key.toLowerCase()) ||
          typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) fail('debug_o11_native_headers_denied');
      out[key] = value;
    }
    const cookie = await state.jar.getCookieString(url.href, { http: true });
    if (cookie) out.Cookie = cookie;
    if (entry && v2) await submitScenarioPost(state, url, body, out);
    else if (login || entry) {
      let payload; try { payload = JSON.parse(body); } catch { fail('debug_o11_native_envelope_invalid'); }
      const spec = login ? policy.login : policy.entry;
      if (typeof body !== 'string' || Buffer.byteLength(body) > 32768 ||
          Object.keys(payload).sort().join(',') !== (login ? 'inputParameters,versionInfo,viewName' : 'screenData,versionInfo,viewName') ||
          payload.versionInfo?.moduleVersion !== policy.manifest.manifest.versionToken || payload.versionInfo.apiVersion !== spec.apiVersion ||
          payload.viewName !== spec.viewName || out['X-CSRFToken'] !== state.communication.CSRF.getCSRFToken())
        fail('debug_o11_native_envelope_invalid');
      if (login && (Object.keys(payload.inputParameters ?? {}).sort().join(',') !== 'Password,RememberLogin,Username' ||
          payload.inputParameters.Username !== state.credentials?.username || payload.inputParameters.Password !== state.credentials?.password ||
          payload.inputParameters.RememberLogin !== false)) fail('debug_o11_native_login_contract_invalid');
      if (entry) {
        const expectedVariables = state.os.Internal.DataConversion.ServerDataConverter.to(
          state.entry.model.variables, state.entry.controller.callContext(), true);
        if (Object.keys(payload.screenData ?? {}).join(',') !== 'variables' ||
            JSON.stringify(payload.screenData.variables) !== JSON.stringify(expectedVariables) ||
            !state.report.authenticated || state.roles.getUserId() !== state.userId ||
            !/^\d{1,10}$/.test(out['OutSystems-ccid'] ?? '')) fail('debug_o11_native_entry_context_invalid');
        state.roles.checkRegistered();
        const submission = { binding: appUserBinding(target, input.sessionId), sessionId: input.sessionId,
          sourceContractSha256: input.sourceContract.sha256, actionKey: spec.actionKey, endpoint: spec.endpoint,
          apiVersion: spec.apiVersion, viewName: spec.viewName, inputsCount: 0, requestEnvelopeVerified: true,
          nativeClientRequestBound: false, userRequestIsolationProved: false, ccidSha256: hash(out['OutSystems-ccid']) };
        if (beforeRequest) await beforeRequest(submission);
        current();
        if (!state.armed || state.roles.getUserId() !== state.userId) fail('debug_o11_native_entry_context_invalid');
        state.report.requestEnvelopeVerified = true;
      }
      reserve(login ? 'login' : 'entry');
    }
    const controller = new AbortController(); state.requests.add(controller);
    const requestToken = entry ? Object.entries(out).find(([name]) => name.toLowerCase() === 'outsystems-request-token')?.[1] : null;
    if (requestToken && /^\d{1,16}$/.test(requestToken)) state.requestTokens.add(requestToken);
    const lease = state.descriptor ? Date.parse(state.descriptor.expiresAt) - now() : 120000;
    const deadline = entry && state.serverInspectionDeadline !== undefined
      ? o11InvocationBudget(state) : Math.min(Math.max(1, timeoutMs), lease, 120000);
    const timer = setTimeout(() => controller.abort(), deadline);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const requestStartedAt = performance.now();
    try {
      const response = await fetchImpl(url.href, { method, headers: out, body, redirect: 'error', credentials: 'omit', signal: controller.signal });
      if (response.url && new URL(response.url).href !== url.href) fail('debug_o11_native_response_origin_changed');
      const chunks = []; let size = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
          if (size > 5 * 1024 * 1024) { await reader.cancel(); fail('debug_o11_native_response_limit'); } chunks.push(Buffer.from(next.value)); }
      } else { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 5 * 1024 * 1024) fail('debug_o11_native_response_limit'); chunks.push(bytes); }
      const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
      if (entry) {
        // Preserve transport evidence before parsing the native envelope. A
        // proxy error page is not an action answer; keep its status and timing
        // without persisting its potentially private body or response headers.
        state.report.lastEntryResponse = {
          status: response.status, durationMs: Math.round(performance.now() - requestStartedAt),
          bytes: bytes.length, sha256: hash(bytes), nativeEnvelopeAccepted: false,
        };
        persist();
      }
      if (suspension) {
        if (response.status !== 200 || !/^(true|false)$/.test(text.trim())) fail('debug_o11_native_suspension_check_invalid');
        state.report.nativeSuspensionChecks = (state.report.nativeSuspensionChecks ?? 0) + 1;
        state.report.lastNativeSuspensionCheck = text.trim() === 'true';
      }
      for (const item of response.headers.getSetCookie()) await state.jar.setCookie(item, url.href, { http: true });
      if (entry && v2) {
        let value; try { value = JSON.parse(text); } catch { fail('debug_o11_native_response_uncertain'); }
        if (!value || typeof value !== 'object' || !('data' in value || 'exception' in value) ||
            value.versionInfo?.hasApiVersionChanged || value.versionInfo?.hasModuleVersionChanged) fail('debug_o11_native_response_uncertain');
        state.scenario.answered++; state.report.requestAnsweredCount++;
        state.report.lastEntryResponse.nativeEnvelopeAccepted = true;
        if (value.exception && typeof value.exception === 'object') state.scenario.serverException = {
          name: typeof value.exception.name === 'string' && /^[A-Za-z]{1,80}$/.test(value.exception.name) ? value.exception.name : 'Exception',
          specificType: typeof value.exception.specificType === 'string' && /^[A-Za-z0-9_.]{1,200}$/.test(value.exception.specificType) ? value.exception.specificType : null,
          endpoint: url.pathname };
      } else if (login || entry) {
        let value; try { value = JSON.parse(text); } catch { fail('debug_o11_native_response_uncertain'); }
        if (!value || typeof value !== 'object' || !('data' in value || 'exception' in value) ||
            value.versionInfo?.hasApiVersionChanged || value.versionInfo?.hasModuleVersionChanged) fail('debug_o11_native_response_uncertain');
        if (login) { state.report.loginAnswered = true; state.report.loginAnsweredCount = 1;
          state.loginAccepted = response.status === 200 && !value.exception; }
        else {
          if (response.status !== 200 || value.exception || !value.data ||
              Object.keys(value.data).sort().join(',') !== policy.entry.outputs.map(o => o.name).sort().join(',') ||
              policy.entry.outputs.some(o => o.type === 'Boolean' ? typeof value.data[o.name] !== 'boolean' : !Number.isSafeInteger(value.data[o.name])))
            fail('debug_o11_native_response_uncertain');
          state.responseOutputs = Object.fromEntries(policy.entry.outputs.map(o => [o.name, value.data[o.name]]));
          state.report.requestAnsweredCount = 1;
          state.report.lastEntryResponse.nativeEnvelopeAccepted = true;
        }
      }
      persist();
      return { status: response.status, text, sha256: hash(bytes), headers: Object.fromEntries([...response.headers].filter(([k]) => !/^set-cookie2?$/i.test(k))), url: url.href };
    } catch (error) {
      if (login && state.report.loginSubmittedCount && !state.report.loginAnsweredCount) state.report.loginUncertain = true;
      if (entry && v2) {
        if (state.scenario && state.scenario.submitted > state.scenario.answered) { state.report.requestUncertain = true; state.scenario.uncertain = true; }
        persist(); throw error?.message?.startsWith('debug_o11_native_') ? error : new Error('debug_o11_native_request_failed');
      }
      if (entry && state.report.requestSubmittedCount && !state.report.requestAnsweredCount) state.report.requestUncertain = true;
      persist(); fail(login ? 'debug_o11_native_login_failed' : 'debug_o11_native_request_failed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); state.requests.delete(controller); if(requestToken) state.requestTokens.delete(requestToken); for (const k of Object.keys(out)) out[k] = ''; }
  };
  const XHR = class {
    constructor() { this.readyState = 0; this.status = 0; this.headers = {}; this.timeout = 120000; this.controller = new AbortController(); }
    open(method, url, async = true) { if (async !== true || !['GET', 'POST'].includes(method)) fail('debug_o11_native_request_denied'); this.method = method; this.url = url; this.readyState = 1; }
    setRequestHeader(key, value) { this.headers[key] = String(value); }
    getResponseHeader(key) { return this.responseHeaders?.[key.toLowerCase()] ?? null; }
    getAllResponseHeaders() { return Object.entries(this.responseHeaders ?? {}).map(([k, v]) => k + ': ' + v).join('\r\n'); }
    send(body) { request(this.method, this.url, { body, headers: this.headers, signal: this.controller.signal, timeoutMs: this.timeout }).then(r => {
      this.status = r.status; this.statusText = ''; this.responseText = r.text; this.responseURL = r.url; this.responseHeaders = r.headers; this.readyState = 4; this.onload?.(); this.onloadend?.();
    }).catch(error => { state.report.diagnostics.requestFailure = publicCode(error); persist();
      this.readyState = 4; this.onerror?.(); this.onloadend?.(); }); }
    abort() { this.controller.abort(); this.readyState = 4; this.onabort?.(); }
  };
  const fresh = async () => {
    const manifest = await request('GET', 'moduleservices/moduleinfo?' + now(), { headers: { Accept: 'application/json' } });
    if (manifest.status !== 200 || manifest.sha256 !== policy.moduleInfo.sha256) fail('debug_o11_native_publication_changed');
  };
  state.persist = persist; state.current = current; state.fresh = fresh;
  state.dispose = async () => {
    const privateCleanup=state.inspection?.dispose()??{completed:true,pending:0};state.report.privateInspectionCleanup=privateCleanup;state.inspector?.close();
    state.closed = true; state.armed = false; state.authenticating = false; state.credentials = undefined; state.userId = undefined;
    state.redact = []; state.scenario = null;
    for (const item of state.requests) item.abort(); for (const timer of state.timers) clearTimeout(timer);
    for (const complete of state.timerCompletions.values()) complete();
    state.requests.clear(); state.timers.clear(); state.timerCompletions.clear(); state.pendingActions.clear(); let released = privateCleanup.completed;
    for (const controller of state.controllers) try { controller.dispose(); } catch { released = false; }
    try { state.sandbox?.OutSystemsDebugger?.endSession(); } catch { released = false; }
    state.controllers.length = 0; state.login = undefined; state.entry = undefined; state.roles = undefined;
    state.communication = undefined; state.context = undefined; state.sandbox = undefined; state.amd = undefined; state.os = undefined;
    state.responseOutputs = undefined; state.descriptor = undefined;
    try { await state.jar.removeAllCookies(); } catch { released = false; }
    try { globalThis.sessionStorage.clear(); } catch { released = false; }
    state.report.memoryCleared = released; state.report.nativeContextReferencesReleased = released;
    state.report.phase = 'disposed'; persist(); return structuredClone(state.report);
  };
  try {
    await fresh();
    for (const asset of policy.assets) { const response = await request('GET', asset.urlPath + asset.query);
      if (response.status !== 200 || response.sha256 !== asset.sha256) fail('debug_o11_native_source_changed'); }
    const deny = () => fail('debug_o11_native_runtime_service_unsupported');
    const sandbox = { console: { log() {}, warn() {}, error() {}, debug() {} }, URL, URLSearchParams, TextEncoder, TextDecoder,
      // Native BinaryData.length calls toBlob -> atob/Blob for nonempty values.
      // Expose the standard APIs; preserve the published getter and converter.
      atob, Blob,
      location: new URL(target.runtimeUrl), OutSystemsApp: { basePath: '/' + target.module + '/' },
      localStorage: globalThis.sessionStorage, sessionStorage: globalThis.sessionStorage,
      XMLHttpRequest: XHR, fetch: deny, WebSocket: deny, importScripts: deny, setInterval: deny, clearInterval() {},
      setTimeout(fn, ms, ...args) {
        const maximum = state.armed && state.serverInspectionDeadline !== undefined ? Math.max(180000, o11InvocationBudget(state)) : 180000;
        if (!Number.isFinite(ms) || ms < 0 || ms > maximum) deny();
        const owner = state.armed ? state.scenario : null;
        let resolve; const completion = owner ? new Promise(done => { resolve = done; }) : null;
        const complete = () => { if (completion) { state.pendingActions.delete(completion); resolve(); } };
        const timer = setTimeout(() => {
          state.timers.delete(timer); state.timerCompletions.delete(timer);
          try {
            if (owner && (state.scenario !== owner || !state.armed)) return;
            const returned = fn(...args);
            if (owner && returned && typeof returned.then === 'function') {
              const pending = Promise.resolve(returned).catch(error => { owner.proxyFailure ??= error; });
              state.pendingActions.add(pending); pending.finally(() => state.pendingActions.delete(pending));
            }
          } catch (error) { if (owner) owner.proxyFailure ??= error; else throw error; }
          finally { complete(); }
        }, ms);
        if (completion) { state.pendingActions.add(completion); state.timerCompletions.set(timer, complete); }
        state.timers.add(timer); return timer; },
      clearTimeout(timer) { state.timers.delete(timer); clearTimeout(timer); state.timerCompletions.get(timer)?.(); state.timerCompletions.delete(timer); } };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
    const context = vm.createContext(sandbox);
    for (const asset of policy.assets) {
      const bytes = fs.readFileSync(asset.path); if (hash(bytes) !== asset.sha256) fail('debug_o11_native_source_changed');
      state.report.sourceAssetsVerified++;
      if (asset.execute) vm.runInContext(bytes.toString('utf8'), context, { filename: asset.name, timeout: 10000 });
    }
    const amd = names => new Promise((resolve, reject) => sandbox.require(names, (...values) => resolve(values), reject));
    const [os, definition, cookies, info, app, roles, variables, communication, logger, versions] = await amd([
      'OutSystems/ClientRuntime/Main', policy.applicationDefinition, 'OutSystems/ClientRuntime/CookiesManager',
      'OutSystems/ClientRuntime/ApplicationInfo', 'OutSystems/ClientRuntime/Application', 'OutSystems/ClientRuntime/RolesInfo',
      'OutSystems/ClientRuntime/modules/ClientVariables/LocalStorageClientVariablesService', 'OutSystems/ClientRuntime/Communication',
      'OutSystems/ClientRuntime/Logger', 'OutSystems/ClientRuntime/VersionsManager']);
    const [nativeDebuggerModule] = await amd(['OutSystems/ClientRuntime/Debugger']);
    state.nativeDebuggerConverter = nativeDebuggerModule.DebuggerDataConverter;
    if (!sandbox.OutSystemsDebugger || sandbox.OutSystemsDebugger.isInSession) fail('debug_o11_native_debugger_context_invalid');
    logger.setTracingEnabled(false);
    if (logger.forceTracing || definition.userProviderName !== policy.userProvider || definition.homeModuleName !== target.module ||
        definition.applicationKey !== policy.nativeApplicationGuid ||
        policy.manifest.data.modules[definition.homeModuleKey]?.ownerAppKey !== definition.applicationKey) fail('debug_o11_native_target_mismatch');
    app.default.setApplicationDefinition(definition); info.setModules(policy.manifest.data.modules);
    if (info.getUserProviderName() !== policy.userProvider || info.getUserCookieName() !== 'nr2' + policy.userProvider)
      fail('debug_o11_native_cookie_contract_invalid');
    cookies.initialize({ getCookies: () => state.jar.getCookieStringSync(target.runtimeUrl, { http: false }) });
    communication.initialize(definition.debugEnabled, info.getUserCookieName()); versions.default.cachedAppInfo = policy.manifest;
    const clientVariables = new variables.default(policy.userProvider);
    if (!os.Internal.Injector.register(os.Internal.ServiceNames.ClientVariablesService, () => clientVariables))
      fail('debug_o11_native_runtime_service_unsupported');
    state.os = os; state.roles = roles; state.communication = communication; state.sandbox = sandbox; state.context = context; state.amd = amd;
    for (const kind of ['login', 'entry']) {
      const spec = policy[kind];
      if (kind === 'entry' && v2) { state.entry = await instantiateGraphEntry(state, os, amd); continue; }
      const [modelFactory, controllerFactory] = await amd([spec.modelFactory, spec.controllerFactory]);
      const model = modelFactory.create({ viewName: spec.viewName, navigatedFromHistory: false, viewWasRestoredFromCache: false });
      const controller = controllerFactory.create(model, new os.Internal.WidgetNaming.WidgetIdService(null));
      state.controllers.push(controller);
      if (!(controller instanceof os.Internal.Controller.BaseViewController) || typeof controller[spec.method] !== 'function')
        fail('debug_o11_native_abi_invalid');
      const payload = controller.getInitialPayloadObject(controller.callContext(), spec.apiVersion);
      if (payload.versionInfo.moduleVersion !== policy.manifest.manifest.versionToken || payload.versionInfo.apiVersion !== spec.apiVersion ||
          payload.viewName !== spec.viewName) fail('debug_o11_native_abi_invalid');
      if (kind === 'entry') {
        const attributes = model.variables[spec.dataProperty]?.getAttributes?.();
        if (!Array.isArray(attributes) || spec.outputs.some(output => attributes.filter(a => a.name === output.name &&
            a.attrName === output.attribute && a.dataType === os.Internal.DataTypes.DataTypes[output.type]).length !== 1))
          fail('debug_o11_native_output_contract_invalid');
      }
      state[kind] = { model, controller };
    }
    state.report.originalLoginController = true; state.report.publishedAbiValidated = true;
    if (roles.getUserId() !== os.Internal.BuiltinFunctions.nullIdentifier()) fail('debug_o11_native_anonymous_context_invalid');
    let refused = false; try { roles.checkRegistered(); } catch (error) { refused = error instanceof os.Internal.Exceptions.Exceptions.NotRegisteredException; }
    if (!refused) fail('debug_o11_native_anonymous_context_invalid');
    state.report.prepared = true; state.report.ok = true; state.report.phase = 'prepared'; persist();
    const handle = { receiptPath: state.receiptPath, receipt: () => structuredClone(state.report), dispose: state.dispose };
    sessions.set(handle, state); return handle;
  } catch (error) {
    state.report.ok = false; state.report.error = publicCode(error); diagnostics(state, error);
    await state.dispose().catch(() => {});
    const failure = new Error(publicCode(error)); failure.receipt = structuredClone(state.report); failure.receiptPath = state.receiptPath;
    throw failure;
  }
}

// ---- v2: graph-chosen entry, typed scenarios ---------------------------------------------------------------
const WIRE_DEFAULTS = Object.freeze({ Integer: 0, LongInteger: '0', Decimal: '0', Currency: '0', Text: '', PhoneNumber: '', Email: '', Boolean: false,
  Date: '1900-01-01', Time: '00:00:00', DateTime: '1900-01-01T00:00:00Z', BinaryData: '' });
const EXCEPTION_TYPES = new Set(['UserException', 'ServerException', 'DataBaseException', 'NotRegisteredException', 'SecurityException',
  'CommunicationException', 'AbortActivityChangeException', 'InvalidLoginException', 'ServiceException', 'TypeError', 'ReferenceError',
  'RangeError', 'SyntaxError']);
const redactText = (state, value, limit = 2000) => {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of state.redact ?? []) text = text.split(secret).join('[private]');
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};
// Wire value (what ServerDataConverter.to produces) -> plain JSON: {List:[...]} becomes an array, strings filtered.
function unwire(state, value) { return nativeWireOutput(value, state.redact ?? []); }
function typedOutput(state, value, dataType) {
  const os = state.os, conv = os.Internal.DataConversion.ServerDataConverter, DT = os.Internal.DataTypes.DataTypes;
  if (value === undefined) return null;
  if (dataType === 'Record' || dataType === 'RecordList') return unwire(state, conv.to(value));
  return unwire(state, conv.to(value, DT[dataType]));
}
// Any runtime value seen in a client frame (trace=full), bounded and filtered.
function projectAny(state, value, depth = 0) {
  const os = state.os, types = os.Internal.DataTypes, conv = os.Internal.DataConversion.ServerDataConverter;
  if (depth > 3) return '[depth-limit]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactText(state, value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return undefined;
  try {
    if (types.VariableHolder && value instanceof types.VariableHolder) return projectAny(state, value.value, depth + 1);
    if (types.LongInteger && value instanceof types.LongInteger) return conv.to(value, types.DataTypes.LongInteger);
    if (types.Decimal && value instanceof types.Decimal) return conv.to(value, types.DataTypes.Decimal);
    if (types.DateTime && value instanceof types.DateTime) return redactText(state, value.toString(), 100);
    // Records and variable groups ($vars/$outVars, results): every declared attribute by name (server-ignored ones too).
    if (typeof value.getAttributes === 'function') {
      const out = {};
      for (const attribute of value.getAttributes().slice(0, 60)) out[attribute.name] = projectAny(state, value[attribute.attrName], depth + 1);
      return out;
    }
    if (typeof value.getItem === 'function' && Number.isInteger(value.length)) {
      const out = []; for (let i = 0; i < Math.min(value.length, 100); i++) out.push(projectAny(state, value.getItem(i), depth + 1)); return out;
    }
    if (value instanceof types.GenericRecord || value instanceof types.List) return unwire(state, conv.to(value));
  } catch { return '[unreadable]'; }
  if (typeof value === 'object') {
    const out = {}; let count = 0;
    for (const key of Object.keys(value)) {
      if (count++ >= 40 || key.startsWith('_')) continue;
      const projected = projectAny(state, value[key], depth + 1);
      if (projected !== undefined) out[key] = projected;
    }
    return out;
  }
  return redactText(state, String(value), 100);
}
function snapshotVarBag(state, varBag) {
  const values = {}; let count = 0;
  for (const key of Object.keys(varBag ?? {})) {
    if (['model', 'idService', 'callContext'].includes(key) || count++ >= 60) continue;
    const projected = projectAny(state, varBag[key]);
    if (projected !== undefined) values[key] = projected;
  }
  if (varBag?.model?.variables) values.$screen = projectAny(state, varBag.model.variables);
  return values;
}
// Client trace: wraps the ORIGINAL OutSystemsDebugger hooks the compiled code already calls; never pauses (no breakpoints).
function hookClientDebugger(state, mode) {
  const debuggerObject = state.sandbox.OutSystemsDebugger, saved = {}, frames = new Map(), visits = [], exceptions = [];
  const started = performance.now(), ms = () => Math.round(performance.now() - started);
  const top = ccid => frames.get(ccid)?.at(-1);
  const wrap = (name, before) => {
    saved[name] = debuggerObject[name];
    debuggerObject[name] = function (...args) { try { before(...args); } catch { /* observation never alters the flow */ } return saved[name].apply(this, args); };
  };
  wrap('push', (fullKey, module, action, flowKind, ccid, varBag) => {
    if (!frames.has(ccid)) frames.set(ccid, []);
    frames.get(ccid).push({ functionKey: String(fullKey).split(':')[1] ?? null, module, action, varBag });
  });
  wrap('pop', (fullKey, ccid) => { frames.get(ccid)?.pop(); });
  wrap('handleBreakpoint', (nodeFull, ccid) => {
    if (mode === 'none' || visits.length >= 2000) return;
    const frame = top(ccid);
    visits.push({ seq: visits.length + 1, ms: ms(), nodeKey: String(nodeFull).split(':')[1] ?? null, functionKey: frame?.functionKey ?? null,
      action: frame?.action ?? null, module: frame?.module ?? null, depth: frames.get(ccid)?.length ?? 0,
      ...(mode === 'full' && frame ? { values: snapshotVarBag(state, frame.varBag) } : {}) });
  });
  wrap('handleException', (error, ccid) => {
    const frame = top(ccid);
    exceptions.push({ ms: ms(), action: frame?.action ?? null, functionKey: frame?.functionKey ?? null,
      type: EXCEPTION_TYPES.has(error?.name) ? error.name : typeof error === 'string' ? 'HandledMessage' : 'Error' });
  });
  return { visits, exceptions, restore() { for (const [name, fn] of Object.entries(saved)) debuggerObject[name] = fn; } };
}
// A canonical scenario value checked against the ORIGINAL runtime class (Class.getAttributes() / getItemType()) before the
// original ServerDataConverter reads it. It converts nothing: it refuses an attribute or item the class does not declare
// with that wire type, and only shapes lists as the {List:[...]} wire the converter reads at every level.
const WIRE_STRINGS = new Set(['Text', 'Email', 'PhoneNumber', 'LongInteger', 'Decimal', 'Currency', 'Date', 'Time', 'DateTime', 'BinaryData']);
export function o11ClassWire(DT, Class, value, depth = 0) {
  const mismatch = () => fail('debug_o11_native_record_class_mismatch');
  if (depth > 32 || typeof Class !== 'function') mismatch();
  const names = Object.fromEntries(Object.entries(DT).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));
  const basic = (type, item) => {
    if (WIRE_STRINGS.has(type) ? typeof item !== 'string' : type === 'Integer' ? !Number.isSafeInteger(item) : type !== 'Boolean' || typeof item !== 'boolean') mismatch();
    return item;
  };
  const itemType = typeof Class.getItemType === 'function' ? Class.getItemType() : undefined;
  if (typeof itemType === 'number' || typeof itemType === 'function') {
    if (!Array.isArray(value)) mismatch();
    return { List: value.map(item => item === null || item === undefined ? mismatch()
      : typeof itemType === 'number' ? basic(names[itemType], item) : o11ClassWire(DT, itemType, item, depth + 1)) };
  }
  const attributes = typeof Class.getAttributes === 'function' ? Class.getAttributes() : null;
  if (!Array.isArray(attributes) || !value || typeof value !== 'object' || Array.isArray(value)) mismatch();
  const wire = {};
  for (const [key, item] of Object.entries(value)) {
    const found = attributes.filter(a => a.name === key);
    if (found.length !== 1) mismatch();
    const type = names[found[0].dataType];
    wire[key] = item === null ? null : type === 'Record' || type === 'RecordList' ? o11ClassWire(DT, found[0].complexType, item, depth + 1) : basic(type, item);
  }
  return wire;
}
function nativeValue(state, input, wire, present) {
  const os = state.os, conv = os.Internal.DataConversion.ServerDataConverter, DT = os.Internal.DataTypes.DataTypes;
  if (input.dataType === 'Record' || input.dataType === 'RecordList') {
    const Class = state.entry.classes[input.name];
    if (!Class) fail('debug_o11_native_record_class_unresolved');
    if (!present || wire === null) return new Class();
    return conv.from(o11ClassWire(DT, Class, wire), Class);
  }
  if (!(input.dataType in WIRE_DEFAULTS)) fail('debug_o11_native_input_conversion_failed');
  return conv.from(present && wire !== null ? wire : WIRE_DEFAULTS[input.dataType], DT[input.dataType]);
}
async function instantiateGraphEntry(state, os, amd) {
  const spec = state.policy.entry;
  let controller, screenController, screenModel, model = null;
  if (spec.moduleLevel) {
    const [moduleController] = await amd([state.target.module + '.controller']);
    await amd([spec.controller]); // the define installs default.<method>
    controller = moduleController?.default;
  } else {
    const [modelFactory, controllerFactory] = await amd([spec.modelFactory, spec.controllerFactory]);
    model = modelFactory.create({ viewName: spec.viewName, navigatedFromHistory: false, viewWasRestoredFromCache: false });
    controller = controllerFactory.create(model, new os.Internal.WidgetNaming.WidgetIdService(null));
    state.controllers.push(controller);
    if (!(controller instanceof os.Internal.Controller.BaseViewController)) fail('debug_o11_native_abi_invalid');
    if (spec.hostScreen) {
      if (spec.hostScreen.controllerFactory === spec.controllerFactory) { screenController = controller; screenModel = model; }
      else {
        const [screenModelFactory, screenControllerFactory] = await amd([spec.hostScreen.modelFactory, spec.hostScreen.controllerFactory]);
        screenModel = screenModelFactory.create({ viewName: spec.hostScreen.viewName, navigatedFromHistory: false, viewWasRestoredFromCache: false });
        screenController = screenControllerFactory.create(screenModel, new os.Internal.WidgetNaming.WidgetIdService(null));
        state.controllers.push(screenController);
      }
      if (typeof screenController.constructor.checkPermissions !== 'function') fail('debug_o11_native_screen_permissions_unavailable');
      screenController.setAsActiveScreen?.();
    }
  }
  if (!controller || typeof controller[spec.method] !== 'function') fail('debug_o11_native_abi_invalid');
  trackO11ClientProxies(controller, state.pendingActions, error => { if (state.scenario) state.scenario.proxyFailure ??= error; });
  if (spec.lifecycle && (typeof controller[spec.lifecycle.handler] !== 'function' || typeof controller.fireEvent !== 'function'))
    fail('debug_o11_native_lifecycle_handler_unavailable');
  if (spec.kind === 'data-action' && !model?.variables?.[spec.dataProperty]) fail('debug_o11_native_abi_invalid');
  const classes = {};
  const DT = os.Internal.DataTypes.DataTypes;
  for (const input of [...spec.inputs, ...(spec.screenVariables ?? [])]) {
    if (!['Record', 'RecordList'].includes(input.dataType)) continue;
    let Class;
    if (input.runtimeList) Class = os.Internal.DataTypes[input.runtimeList]; // basic list of the pinned published runtime
    else {
      const [base, className] = (input.recordClass ?? '').split('$');
      if (!base || !className) fail('debug_o11_native_record_class_unresolved');
      await amd([input.recordClass]);
      const [modelModule] = await amd([base]);
      Class = modelModule?.[className];
    }
    if (typeof Class !== 'function') fail('debug_o11_native_record_class_unresolved');
    // A basic-type list is used only when the original class's item type is that basic type.
    if (input.element && (typeof Class.getItemType !== 'function' || Class.getItemType() !== DT[input.element])) fail('debug_o11_native_record_class_mismatch');
    classes[input.name] = Class;
  }
  let viewName = null;
  try { viewName = controller.getInitialPayloadObject?.(controller.callContext(), spec.apiVersion ?? state.policy.login.apiVersion)?.viewName ?? null; } catch { viewName = null; }
  return { model, controller, classes, viewName, screenController, screenModel };
}

function contextValue(state, model, spec, wire) {
  const os = state.os, attributes = model.variables.getAttributes?.();
  const found = attributes?.filter(a => a.attrName === spec.attribute && a.name === spec.name) ?? [];
  if (found.length !== 1 || found[0].dataType !== os.Internal.DataTypes.DataTypes[spec.dataType])
    fail('debug_o11_native_context_attribute_unavailable');
  const conversion = os.Internal.DataConversion.ServerDataConverter;
  if (['Record', 'RecordList'].includes(spec.dataType)) {
    const Class = model.variables[spec.attribute]?.constructor;
    if (typeof Class !== 'function' || Class === Object || Class === Array) fail('debug_o11_native_record_class_unresolved');
    return wire === null ? new Class() : conversion.from(o11ClassWire(os.Internal.DataTypes.DataTypes, Class, wire), Class);
  }
  if (!(spec.dataType in WIRE_DEFAULTS)) fail('debug_o11_native_input_conversion_failed');
  return conversion.from(wire === null ? WIRE_DEFAULTS[spec.dataType] : wire, found[0].dataType);
}
// Every POST of a scenario: the original runtime built it; this checks its envelope, accounts it with the parent and
// reserves a one-shot marker BEFORE the fetch. A lost answer is uncertain and never resent.
async function submitScenarioPost(state, url, body, headers) {
  const policy = state.policy;
  let payload; try { payload = JSON.parse(body); } catch { fail('debug_o11_native_envelope_invalid'); }
  const keys = Object.keys(payload ?? {});
  if (!state.scenario || typeof body !== 'string' || Buffer.byteLength(body) > O11_NATIVE_ENVELOPE_BYTES ||
      !keys.includes('versionInfo') || !keys.includes('viewName') || keys.some(k => !['versionInfo', 'viewName', 'inputParameters', 'screenData', 'clientVariables'].includes(k)) ||
      payload.versionInfo?.moduleVersion !== policy.manifest.manifest.versionToken ||
      (policy.entry.endpointVersions?.[url.pathname] && payload.versionInfo.apiVersion !== policy.entry.endpointVersions[url.pathname]) ||
      // The entry's own endpoint carries the entry controller's view; calls a client action makes through other
      // controllers carry whatever view the original runtime sets for them.
      (url.pathname === policy.entry.endpoint && state.entry.viewName !== null && payload.viewName !== state.entry.viewName) ||
      headers['X-CSRFToken'] !== state.communication.CSRF.getCSRFToken()) fail('debug_o11_native_envelope_invalid');
  // The ccid header is the client debugger's correlation id; a stub called outside a client flow may omit it.
  if (!state.report.authenticated || state.roles.getUserId() !== state.userId ||
      (headers['OutSystems-ccid'] !== undefined && !/^\d{1,16}$/.test(headers['OutSystems-ccid']))) fail('debug_o11_native_entry_context_invalid');
  const seq = ++state.postSeq;
  if (seq > 1000 || state.scenario.submitted >= 20) fail('debug_o11_native_request_denied');
  const submission = { binding: appUserBinding(state.target, state.input.sessionId), sessionId: state.input.sessionId,
    sourceContractSha256: state.input.sourceContract.sha256, scenario: state.scenario.name, seq, endpoint: url.pathname,
    actionKey: policy.entry.actionKey ?? null, requestEnvelopeVerified: true, userRequestIsolationProved: false };
  if (typeof state.beforeRequest !== 'function') fail('debug_o11_native_submission_refused');
  await state.beforeRequest(submission);
  state.current();
  if (!state.armed || state.roles.getUserId() !== state.userId) fail('debug_o11_native_entry_context_invalid');
  const marker = path.join(state.input.directory, state.input.sessionId + '.post-' + seq + '.json');
  let fd; try { fd = fs.openSync(marker, 'wx'); } catch { fail('debug_o11_native_already_submitted'); }
  try { fs.writeFileSync(fd, JSON.stringify({ sessionId: state.input.sessionId, seq, scenario: state.scenario.name, endpoint: url.pathname })); }
  finally { fs.closeSync(fd); }
  state.scenario.submitted++; state.report.requestSubmittedCount++; state.report.requestEnvelopeVerified = true;
  state.persist();
}

export async function invokeScenarioO11Entry(handle, scenario) {
  const state = sessions.get(handle); if (!state || !state.v2) fail('debug_o11_native_session_invalid'); state.current();
  if (!state.report.authenticated || state.report.loginUncertain || state.report.requestUncertain) fail('debug_o11_native_invocation_refused');
  if (!scenario || typeof scenario.name !== 'string' || !/^[\w .:@-]{1,80}$/.test(scenario.name) || !scenario.values || typeof scenario.values !== 'object' ||
      Array.isArray(scenario.values) || !['none', 'nodes', 'full'].includes(scenario.trace ?? 'none')) fail('debug_o11_native_scenario_invalid');
  state.report.scenarios ??= [];
  if (state.report.scenarios.length >= 50 || state.report.scenarios.some(s => s.name === scenario.name)) fail('debug_o11_native_invocation_refused');
  await state.fresh(); state.roles.checkRegistered();
  state.entry.screenController?.constructor.checkPermissions();
  const spec = state.policy.entry, { controller, model } = state.entry, os = state.os;
  let args, contextReceipt;
  try {
    contextReceipt = applyO11Context({ owners: spec.context,
      models: { screen: state.entry.screenModel, block: spec.context?.block ? model : undefined }, value: scenario.context,
      convert: (ownerModel, variable, wire) => contextValue(state, ownerModel, variable, wire) });
    args = spec.inputs.map(input => nativeValue(state, input, scenario.values[input.name], Object.hasOwn(scenario.values, input.name)));
    for (const variable of spec.screenVariables ?? [])
      if (Object.hasOwn(scenario.screen ?? {}, variable.name)) model.variables[variable.attribute] = nativeValue(state, variable, scenario.screen[variable.name], true);
  } catch (error) { fail(o11NativePublicCode(error?.message, 'debug_o11_native_input_conversion_failed')); }
  state.scenario = { name: scenario.name, submitted: 0, answered: 0, uncertain: false, serverException: null };
  const result = { name: scenario.name, ok: false, outputs: null, exception: null,
    ...(contextReceipt ? { context: contextReceipt } : {}),
    ...(spec.lifecycle ? { lifecycle: { event: spec.lifecycle.event, handler: spec.lifecycle.handler, invoked: false, mounted: false } } : {}),
    accessContext: { nativeLogin: true, rolesLoadedFromServer: state.report.rolesLoadedFromServer === true,
      screenPermissionsChecked: !!state.entry.screenController, clientIdentityMatchesBeforeAfter: false, serverPropagationProved: false } };
  const hooks = hookClientDebugger(state, scenario.trace ?? 'none'), nativeDebugger = state.sandbox.OutSystemsDebugger;
  let timer, restoreNativeTimeout; const started = performance.now();
  try {
    if (nativeDebugger.isInSession) fail('debug_o11_native_debugger_context_invalid');
    nativeDebugger.clearBreakpoints(); nativeDebugger.startSession();
    if (state.inspection) state.inspection.enable(state.inspectionOptions);
    state.armed = true;
    restoreNativeTimeout = o11NativeInspectionTimeout(state);
    const budget = o11InvocationBudget(state), timeoutSeconds = Math.ceil(budget / 1000);
    const context = controller.callContext().withTimeout ? controller.callContext().withTimeout(timeoutSeconds) : controller.callContext();
    const call = spec.lifecycle ? invokeO11Lifecycle(controller, spec.lifecycle, timeoutSeconds)
      : spec.kind === 'data-action' ? controller[spec.method](context) : controller[spec.method](...args, context);
    if (result.lifecycle) result.lifecycle.invoked = true;
    const completion = Promise.resolve(call).then(async value => {
      await settleO11ClientProxies(state.pendingActions);
      if (state.scenario.proxyFailure) throw state.scenario.proxyFailure;
      return value;
    });
    const value = await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => {
      state.armed = false; for (const pending of state.requests) pending.abort(); reject(new Error('debug_o11_native_timeout')); }, budget); })]);
    state.current(); state.roles.checkRegistered();
    if (state.roles.getUserId() !== state.userId) fail('debug_o11_native_result_unproved');
    result.accessContext.clientIdentityMatchesBeforeAfter = true;
    if (spec.kind === 'data-action') {
      const record = model.variables[spec.dataProperty];
      if (!record || record.isDataFetchedAttr !== true) fail('debug_o11_native_result_unproved');
      result.outputs = Object.fromEntries(record.getAttributes().filter(a => !/^(isDataFetched|dataFetchStatus)Attr$/.test(a.attrName))
        .map(a => [a.name, a.dataType === os.Internal.DataTypes.DataTypes.Record || a.dataType === os.Internal.DataTypes.DataTypes.RecordList
          ? unwire(state, os.Internal.DataConversion.ServerDataConverter.to(record[a.attrName])) : unwire(state, os.Internal.DataConversion.ServerDataConverter.to(record[a.attrName], a.dataType))]));
    } else result.outputs = Object.fromEntries(spec.outputs.map(o => [o.name, typedOutput(state, value?.[o.attribute], o.dataType)]));
    result.outputs = nativeWireOutput(result.outputs, [], { unwrapLists: false });
    result.ok = true;
  } catch (error) {
    const code = typeof error?.message === 'string' && error.message.startsWith('debug_o11_native_') ? o11NativePublicCode(error.message) : null;
    // The runtime names a typed server exception after its specificType; the wire answer keeps the base class name.
    const server = state.scenario.serverException;
    result.exception = { type: server && !code ? server.name : EXCEPTION_TYPES.has(error?.name) ? error.name : code ? 'Harness' : 'Error',
      specificType: typeof error?.specificType === 'string' && /^[A-Za-z0-9_.]{1,200}$/.test(error.specificType) ? error.specificType : null,
      origin: code ? 'harness' : state.scenario.serverException ? 'server' : 'client',
      message: code ? code : redactText(state, error?.message ?? '', 500), ...(code ? { code } : {}) };
  } finally {
    clearTimeout(timer); restoreNativeTimeout?.(); state.inspection?.finish(); hooks.restore(); try { nativeDebugger.endSession(); } catch { /* local only */ } state.armed = false;
    for (const [pendingTimer, complete] of state.timerCompletions) { clearTimeout(pendingTimer); state.timers.delete(pendingTimer); complete(); }
    state.timerCompletions.clear();
  }
  if (!result.ok && hooks.exceptions.length && !result.exception) result.exception = { type: hooks.exceptions[0].type, origin: 'client' };
  if (result.ok && hooks.exceptions.length) result.handledExceptions = hooks.exceptions; // original handlers ran (safeExecuteClientAction)
  if (state.scenario.serverException) result.serverException = state.scenario.serverException;
  result.durationMs = Math.round(performance.now() - started);
  // Business exceptions still need an explicit client-context result. This is not evidence about a server/library frame.
  try { state.roles.checkRegistered(); result.accessContext.clientIdentityMatchesBeforeAfter = state.roles.getUserId() === state.userId; } catch { /* false */ }
  result.requests = { submitted: state.scenario.submitted, answered: state.scenario.answered };
  result.uncertain = state.scenario.uncertain || state.scenario.submitted > state.scenario.answered;
  if (result.uncertain) state.report.requestUncertain = true;
  if ((scenario.trace ?? 'none') !== 'none') { result.visits = hooks.visits; result.visitCount = hooks.visits.length; }
  state.report.scenarios.push({ name: scenario.name, ok: result.ok, submitted: result.requests.submitted, answered: result.requests.answered, uncertain: result.uncertain });
  state.report.phase = 'invoked'; state.persist(); state.scenario = null;
  return { ok: true, scenario: result };
}

export function configureOriginalO11ServerInspection(handle, options) {
  const state = sessions.get(handle); if (!state) fail('debug_o11_native_session_invalid'); state.current();
  const result = o11InspectionDeadline(state, options); state.persist(); return result;
}

export async function authenticateOriginalO11Entry(handle, descriptor, { vault = privateAppUserVault } = {}) {
  const state = sessions.get(handle); if (!state) fail('debug_o11_native_session_invalid'); state.current();
  const safe = validatePrivateDescriptor(descriptor);
  if (!sameAppUserTarget(safe.binding, appUserBinding(state.target, state.input.sessionId)) || Date.parse(safe.expiresAt) <= state.now() || state.report.loginSubmittedCount)
    fail('debug_o11_native_session_invalid');
  state.descriptor = safe; await state.fresh();
  const record = await vault('read', safe);
  try {
    if (!record?.ok || record.kind !== 'credentials' || !sameAppUserTarget(record.binding, safe.binding) ||
        !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= state.now() ||
        typeof record.username !== 'string' || !record.username || typeof record.password !== 'string' || !record.password)
      fail('debug_o11_native_credentials_unavailable');
    state.credentials = { username: record.username, password: record.password };
    // v2 outputs/traces/exception messages are filtered against these values until dispose; never persisted.
    if (state.v2) state.redact = [record.username, record.password].filter(v => typeof v === 'string' && v.length >= 3);
    state.authenticating = true;
    state.report.diagnostics.phase = 'original-login';
    await state.login.controller[state.policy.login.method](state.credentials.username, state.credentials.password, false, state.login.controller.callContext().withTimeout(120));
    if (!state.report.loginAnsweredCount || !state.loginAccepted) fail('debug_o11_native_login_rejected');
    state.report.diagnostics.phase = 'native-roles-get';
    const roles = await state.communication.getRoles(); if (typeof roles !== 'string') fail('debug_o11_native_roles_unavailable');
    state.report.diagnostics.phase = 'native-roles-store';
    await state.roles.storeRoleInformation(roles);
    state.report.diagnostics.phase = 'native-registered';
    state.roles.checkRegistered(); state.userId = state.roles.getUserId();
    if (state.userId === state.os.Internal.BuiltinFunctions.nullIdentifier()) fail('debug_o11_native_login_identity_unavailable');
    state.report.authenticated = true; state.report.nativeCheckRegisteredPassed = true; state.report.rolesLoadedFromServer = true;
    if (state.entry.screenController) {
      state.entry.screenController.constructor.checkPermissions(); state.report.nativeScreenPermissionsPassed = true;
    }
    state.report.phase = 'authenticated'; state.persist(); return { ok: true, ...handle.receipt() };
  } catch (error) { state.report.ok = false; state.report.error = publicCode(error); diagnostics(state, error); state.persist(); throw new Error(publicCode(error)); }
  finally { state.authenticating = false; state.credentials = undefined;
    if (record && typeof record === 'object') { record.username = ''; record.password = ''; } }
}

export async function invokeOriginalO11Entry(handle) {
  const state = sessions.get(handle); if (!state) fail('debug_o11_native_session_invalid'); state.current();
  if (!state.report.authenticated || state.report.loginUncertain || state.report.requestSubmittedCount || state.invocationAttempted)
    fail('debug_o11_native_invocation_refused');
  state.invocationAttempted = true;
  await state.fresh(); state.roles.checkRegistered(); state.armed = true;
  let timer;
  try {
    state.report.diagnostics.phase = 'native-refresh';
    // The original runtime emits ccid only while its local correlation session is active.
    // No breakpoints are installed and no server debugger transport is opened here.
    const nativeDebugger = state.sandbox.OutSystemsDebugger;
    if (nativeDebugger.isInSession) fail('debug_o11_native_debugger_context_invalid');
    nativeDebugger.clearBreakpoints(); nativeDebugger.startSession();
    state.report.clientRuntimeCorrelationEnabled = true;
    const budget = o11InvocationBudget(state);
    await Promise.race([state.entry.controller[state.policy.entry.method](state.entry.controller.callContext().withTimeout(Math.ceil(budget / 1000))),
      new Promise((_, reject) => { timer = setTimeout(() => { state.armed = false; for (const controller of state.requests) controller.abort();
        reject(new Error('debug_o11_native_timeout')); }, budget); })]);
    state.current(); state.roles.checkRegistered();
    const record = state.entry.model.variables[state.policy.entry.dataProperty];
    if (!record || record.isDataFetchedAttr !== true || state.report.requestAnsweredCount !== 1 || state.roles.getUserId() !== state.userId)
      fail('debug_o11_native_result_unproved');
    const outputs = Object.fromEntries(state.policy.entry.outputs.map(o => [o.name, record[o.attribute]]));
    if (state.policy.entry.outputs.some(o => outputs[o.name] !== state.responseOutputs?.[o.name])) fail('debug_o11_native_result_unproved');
    state.report.outputs = outputs; state.report.originalRecordMatchesResponse = true;
    state.report.nativeUserIdBeforeAfterMatches = true; state.report.ok = true; state.report.phase = 'completed'; state.persist();
    return { ok: true, ...handle.receipt() };
  } catch (error) { state.report.ok = false; state.report.error = publicCode(error); diagnostics(state, error);
    if (state.report.requestSubmittedCount && !state.report.requestAnsweredCount) state.report.requestUncertain = true;
    state.persist(); throw new Error(publicCode(error)); }
  finally { clearTimeout(timer); state.sandbox?.OutSystemsDebugger?.endSession(); state.armed = false; state.responseOutputs = undefined; }
}

// Stored for enable() at invocation: breakpoints and the original
// pauseOnAllExceptions switch only, validated before inspection exists.
export function o11InspectionEnableOptions(input) {
  try { return clientInspectionEnableOptions(input ?? {}); } catch { fail('debug_o11_native_preparation_invalid'); }
}

export function originalO11WorkerSuccess(id, result, receipt) {
  // RPC completion is distinct from a previous login/scenario outcome in the receipt.
  return { ...result, id, ok: true, receipt };
}

async function main() {
  let handle, busy = false, currentId, seq = 0;
  const gates = new Map();
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 1024 * 1024) { input.close(); return; }
    let message; try { message = JSON.parse(line); } catch { input.close(); return; }
    if (message.op === 'submission-ack') {
      // v1 acknowledges without seq (one submission); v2 acknowledges each POST by its seq.
      const key = Number.isSafeInteger(message.seq) ? message.seq : [...gates.keys()][0];
      const active = message.id === currentId ? gates.get(key) : undefined;
      if (active) { gates.delete(key); message.accepted === true ? active.resolve() : active.reject(new Error('debug_o11_native_submission_refused')); }
      return;
    }
    if (busy || !Number.isSafeInteger(message.id)) { input.close(); return; }
    busy = true; currentId = message.id;
    (async () => {
      let result;
      if (message.op === 'prepare' && !handle) {
        handle = await prepareOriginalO11Entry(message.input, { beforeRequest: submission => new Promise((resolve, reject) => {
          const own = ++seq; gates.set(own, { resolve, reject }); emit({ kind: 'submission', id: currentId, seq: own, submission });
        }) });
        result = { receiptPath: handle.receiptPath };
      } else if (message.op === 'configure-inspection' && handle) {
        const state = sessions.get(handle);
        if (state.inspection || state.armed || state.serverInspectionDeadline !== undefined) fail('debug_o11_native_session_busy');
        const enableOptions = o11InspectionEnableOptions(message.input);
        state.inspection = createNativeClientInspection({ debuggerObject: state.sandbox.OutSystemsDebugger,
          binaryType: state.os.Internal.DataTypes.BinaryData,
          nativeConverter: state.nativeDebuggerConverter,
          globalObject: state.sandbox, platform: 'o11', modules: message.input.modules, variables: message.input.variables,
          privateChannel:createPrivateInspectionChannel({binding:state.descriptor.binding,sources:message.input.modules,
            expiresAt:new Date(Math.min(Date.parse(state.descriptor.expiresAt),Date.now()+message.input.leaseMs)).toISOString()}),
          redact: value => redactNativeClientValue(value, state.redact) });
        state.inspectionOptions = enableOptions;
        state.inspector = openNativeClientInspector();
        result = { inspectionCapability: { url: state.inspector.url, helperName: state.inspection.helperName,privateConsumerCapability:state.inspection.privateConsumerCapability } };
      } else if (message.op === 'configure-server-inspection' && handle) {
        result = configureOriginalO11ServerInspection(handle, message.input);
      } else if (message.op === 'authenticate' && handle) result = await authenticateOriginalO11Entry(handle, message.input.descriptor);
      else if (message.op === 'invoke' && handle && message.input?.scenario) result = await invokeScenarioO11Entry(handle, message.input.scenario);
      else if (message.op === 'invoke' && handle) result = await invokeOriginalO11Entry(handle);
      else if (message.op === 'dispose' && handle) result = await handle.dispose();
      else fail('debug_o11_native_operation_invalid');
      emit(originalO11WorkerSuccess(currentId, result, handle?.receipt()));
    })().catch(error => emit({ id: currentId, ok: false, error: publicCode(error), receipt: handle?.receipt() ?? error.receipt,
      receiptPath: handle?.receiptPath ?? error.receiptPath }))
      .finally(() => { busy = false; });
  });
  input.on('close', () => { for (const active of gates.values()) active.reject(new Error('debug_o11_native_parent_closed')); gates.clear();
    handle?.dispose().catch(() => {}); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

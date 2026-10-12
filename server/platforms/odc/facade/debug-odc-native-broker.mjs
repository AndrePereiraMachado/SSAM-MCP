import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectNativeClientInspector } from './debug-native-client-inspection.mjs';
import { createPrivateInspectionChannel } from './debug-private-inspection.mjs';
import {isOdcMountRequest} from './debug-odc-browser-mount.mjs';
import {compareNativeRenderEvidence} from './debug-native-browser-render-observation.mjs';
import {isNativeInteractionAuthorization} from './debug-native-browser-interaction.mjs';
const workerFile = fileURLToPath(new URL('./debug-odc-native-worker.mjs', import.meta.url));
// moduleKey:functionKey of a native frame elementKey; never its path or values.
const frameFunction = frame => { const [moduleKey, functionKey] = String(frame?.elementKey ?? '').split(':');
  return /^[A-Za-z0-9_+]{22}$/.test(moduleKey ?? '') && /^[A-Za-z0-9_+]{22}(?:\.#FlowExceptionHandler)?$/.test(functionKey ?? '') ? moduleKey + ':' + functionKey : null; };

export function createOdcNativeBroker({ spawnImpl = spawn, beforeRequest = async () => false,
  connectInspector = connectNativeClientInspector, privateChannelFactory = createPrivateInspectionChannel, ownedBrowser,
  beforeBrowserSync, recordBrowserSyncResult, beforeBrowserMount, recordBrowserMountResult,
  beforeBrowserControllerLoad, recordBrowserControllerLoadResult, beforeBrowserNavigation, recordBrowserNavigationResult, mountAuthorization,
  interactionAuthorization, beforeBrowserInteraction, recordBrowserInteractionResult } = {}) {
  const browserAuthentication = typeof beforeBrowserSync === 'function' && typeof recordBrowserSyncResult === 'function';
  if ((beforeBrowserSync !== undefined || recordBrowserSyncResult !== undefined) && !browserAuthentication)
    throw new Error('debug_odc_native_browser_journal_invalid');
  const browserControllerLoad = typeof beforeBrowserControllerLoad === 'function' && typeof recordBrowserControllerLoadResult === 'function';
  if ((beforeBrowserControllerLoad !== undefined || recordBrowserControllerLoadResult !== undefined) && (!browserControllerLoad || !browserAuthentication))
    throw new Error('debug_odc_native_browser_controller_journal_invalid');
  const browserMount = typeof beforeBrowserMount === 'function' && typeof recordBrowserMountResult === 'function';
  if ((beforeBrowserMount !== undefined || recordBrowserMountResult !== undefined) && (!browserMount || !browserAuthentication))
    throw new Error('debug_odc_native_browser_mount_journal_invalid');
  // A mount needs both journals, an owned browser and the user's Development authorization.
  if (browserMount !== (mountAuthorization !== undefined) || browserMount && (!ownedBrowser || !isOdcMountRequest(mountAuthorization)))
    throw new Error('debug_odc_native_browser_mount_journal_invalid');
  // In-app navigation needs its own journals and an authorized navigation target.
  const browserNavigation = typeof beforeBrowserNavigation === 'function' && typeof recordBrowserNavigationResult === 'function';
  if ((beforeBrowserNavigation !== undefined || recordBrowserNavigationResult !== undefined) !== browserNavigation ||
      browserNavigation !== (browserMount && mountAuthorization?.navigation !== undefined))
    throw new Error('debug_odc_native_browser_navigation_journal_invalid');
  // A trusted click needs its own journals, an authorized mount and the resolved targets recorded before the browser.
  const browserInteraction = typeof beforeBrowserInteraction === 'function' && typeof recordBrowserInteractionResult === 'function';
  if ((beforeBrowserInteraction !== undefined || recordBrowserInteractionResult !== undefined) !== browserInteraction ||
      browserInteraction !== (browserMount && interactionAuthorization !== undefined) ||
      interactionAuthorization !== undefined && !isNativeInteractionAuthorization(interactionAuthorization))
    throw new Error('debug_odc_native_browser_interaction_journal_invalid');
  if (ownedBrowser && (typeof ownedBrowser.dispose !== 'function' || ownedBrowser.receipt?.().scope !== 'owned-browser-process'))
    throw new Error('debug_odc_native_browser_owner_invalid');
  const child = spawnImpl(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', workerFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let sequence = 0, buffer = '', ended = false, disposed = false, inspection, serverInspectionExpiresAt, appUserDescriptor, hostPrivateChannel;
  let browserCleanup, browserInspectionExpiresAt;
  // Counts, timestamps and the paused function identity per stop; paused values stay with the session owner.
  // Exception stops (pauseOnExceptions) keep the function identity and the allowlisted native type only.
  const activity = { configured: false, paused: false, stops: 0, functions: [], exceptions: [], lastChangeAt: null };
  // Private to this process, for render equality only: the session's own last
  // complete scalar read per function and variable. Never in activity or receipts.
  let pausedFrames, readSequence = 0;
  const scopeRefs = new Map(), lastReads = new Map();
  function rememberReads(input, result) {
    if (input?.op === 'scope' && Array.isArray(result?.variables)) for (const v of result.variables) {
      const fn = pausedFrames?.stop === v?.stop ? pausedFrames.frames[v.frame] : null;
      if (fn && typeof v.ref === 'string' && typeof v.name === 'string') scopeRefs.set(v.ref, fn + '\n' + v.name);
    }
    if (!['read', 'refresh', 'read-many'].includes(input?.op)) return;
    for (const item of input.op === 'read-many' ? (Array.isArray(result?.values) ? result.values : []) : [result]) {
      const identity = scopeRefs.get(item?.ref); if (!identity) continue;
      const usable = item.ok !== false && item.redacted === false && item.valueComplete === true &&
        typeof item.value?.type === 'string' && ['string', 'number'].includes(typeof item.value.value);
      // A later unusable read makes the older value stale, never current.
      lastReads.set(identity, usable ? { sequence: ++readSequence, type: item.value.type, text: String(item.value.value) } : { sequence: ++readSequence });
    }
  }
  const lastRead = (functions, variable) => {
    let found; for (const fn of functions) { const read = lastReads.get(fn + '\n' + variable); if (read && (!found || read.sequence > found.sequence)) found = read; }
    return found?.text === undefined ? undefined : { type: found.type, text: found.text };
  };
  function closeBrowser() {
    if (!browserCleanup) browserCleanup = Promise.resolve().then(() => ownedBrowser?.dispose() ?? {completed:true})
      .catch(() => ({completed:false}));
    return browserCleanup;
  }
  function rejectAll() { ended = true; void closeBrowser(); for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('debug_odc_native_worker_lost')); } pending.clear(); }
  const closed = new Promise(resolve => child.once('close', () => { rejectAll(); resolve(true); }));
  child.once('error', rejectAll); child.stdin.on('error', rejectAll); child.stdout.setEncoding('utf8');
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  child.stdout.on('data', bytes => {
    buffer += bytes; if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { child.kill(); rejectAll(); return; }
    let pos; while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1); let reply;
      try { reply = JSON.parse(line); } catch { child.kill(); rejectAll(); return; }
      if (reply.op === 'before-request') {
        Promise.resolve().then(() => beforeRequest(reply.metadata)).then(accepted => { if (!ended) send({ op: 'request-approved', id: reply.id, accepted: accepted === true }); }, () => { if (!ended) send({ op: 'request-approved', id: reply.id, accepted: false }); });
        continue;
      }
      if (['before-browser-sync','browser-sync-result','before-browser-mount','browser-mount-result','before-browser-controller-load','browser-controller-load-result',
        'before-browser-navigation','browser-navigation-result','before-browser-interaction','browser-interaction-result'].includes(reply.op)) {
        const journal = {'before-browser-sync':beforeBrowserSync,'browser-sync-result':recordBrowserSyncResult,
          'before-browser-mount':beforeBrowserMount,'browser-mount-result':recordBrowserMountResult,
          'before-browser-controller-load':beforeBrowserControllerLoad,'browser-controller-load-result':recordBrowserControllerLoadResult,
          'before-browser-navigation':beforeBrowserNavigation,'browser-navigation-result':recordBrowserNavigationResult,
          'before-browser-interaction':beforeBrowserInteraction,'browser-interaction-result':recordBrowserInteractionResult}[reply.op];
        Promise.resolve().then(() => typeof journal === 'function' ? journal(reply.metadata) : undefined)
          .then(result => { if (!ended) send({op:'request-approved',id:reply.id,accepted:result?.recorded === true}); },
            () => { if (!ended) send({op:'request-approved',id:reply.id,accepted:false}); });
        continue;
      }
      const request = pending.get(reply.id); if (!request) continue; pending.delete(reply.id); clearTimeout(request.timer);
      reply.ok ? request.resolve(reply.result) : request.reject(new Error(/^debug_[a-z_]+$/.test(reply.error ?? '') ? reply.error : 'debug_odc_native_worker_failed'));
    }
  });
  function call(op, input, timeout = 60000) {
    if (ended) return Promise.reject(new Error('debug_odc_native_worker_lost'));
    return new Promise((resolve, reject) => {
      const id = String(++sequence), timer = setTimeout(() => { pending.delete(id); reject(new Error('debug_odc_native_worker_timeout')); child.kill(); }, timeout);
      pending.set(id, { resolve, reject, timer, op, timeout }); send({ id, op, input });
    });
  }
  return {
    async configureServerInspection(options) {
      const result = await call('configure-server-inspection', options);
      const deadline = Date.parse(result?.expiresAt);
      if (result?.configured !== true || !Number.isFinite(deadline) || deadline <= Date.now())
        throw new Error('debug_odc_native_inspection_deadline_invalid');
      serverInspectionExpiresAt = deadline;
      return result;
    },
    async configureInspection({ onEvent, ...options }) {
      if (inspection) throw new Error('debug_native_client_already_configured');
      const leaseMs = options.leaseMs ?? 300000;
      if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 1800000)
        throw new Error('debug_odc_native_inspection_deadline_invalid');
      const browserDeadline = ownedBrowser ? Math.min(Date.now()+leaseMs,Date.parse(appUserDescriptor?.expiresAt)) : undefined;
      if (ownedBrowser && (!Number.isFinite(browserDeadline) || browserDeadline <= Date.now()))
        throw new Error('debug_odc_native_inspection_deadline_invalid');
      const capability = await call('configure-inspection', {...options,...(ownedBrowser ? {inspectionExpiresAt:new Date(browserDeadline).toISOString()} : {})});
      if (ownedBrowser) browserInspectionExpiresAt = browserDeadline;
      if (capability.privateCapture === true) {
        const expires = Math.min(Date.parse(appUserDescriptor?.expiresAt), browserDeadline ?? Date.now() + leaseMs);
        if (!appUserDescriptor?.binding || !Number.isFinite(expires) || expires <= Date.now())
          throw new Error('debug_odc_native_inspection_deadline_invalid');
        hostPrivateChannel = privateChannelFactory({ binding: appUserDescriptor.binding, sources: options.modules,
          expiresAt: new Date(expires).toISOString() });
      }
      try { inspection = await connectInspector({ ...capability, ...(hostPrivateChannel ? {privateChannel:hostPrivateChannel} : {}), onEvent: event => {
        if (event.kind === 'paused') {
          activity.paused = true; activity.stops++; activity.lastChangeAt = Date.now();
          const frames = Array.isArray(event.frames) ? event.frames.map(frameFunction) : [];
          pausedFrames = { stop: event.stop, frames };
          if (frames[event.frame]) activity.functions.push(frames[event.frame]);
          if (event.reason === 'exception') activity.exceptions.push({ stop: activity.stops, function: frames[event.frame] ?? null,
            type: /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(event.exception?.type ?? '') ? event.exception.type : 'unknown' });
        }
        else if (event.kind === 'resumed') { activity.paused = false; activity.lastChangeAt = Date.now(); }
        for (const [id, request] of pending) if (request.op === 'invoke') {
          if (event.kind === 'paused') clearTimeout(request.timer);
          if (event.kind === 'resumed') request.timer = setTimeout(() => {
            pending.delete(id); request.reject(new Error('debug_odc_native_worker_timeout')); child.kill();
          }, request.timeout);
        }
        onEvent?.(event);
      }, leaseMs: ownedBrowser ? Math.min(leaseMs,browserInspectionExpiresAt-Date.now()) : leaseMs, terminate: () => child.kill() }); }
      catch(error) { hostPrivateChannel?.close(); throw error; }
      activity.configured = true; activity.lastChangeAt = Date.now();
      return { configured: true, runtime: 'client', mode: 'interactive' };
    },
    inspection: input => inspection ? inspection.command(input).then(result => { try { rememberReads(input, result); } catch { /* evidence only */ } return result; })
      : Promise.reject(new Error('debug_native_client_not_configured')),
    inspectionActivity: () => ({ ...activity, functions: [...activity.functions], exceptions: activity.exceptions.map(e => ({ ...e })), ended }),
    consumePrivateInspection: (descriptor,consume) => inspection ? inspection.consumePrivate(descriptor,consume) : Promise.reject(new Error('debug_native_client_not_configured')),
    prepare: input => call('prepare', input, 120000),
    observeBrowserStartup: () => call('observe-browser-startup', {}, 10000),
    resolveBrowserViewResources: screenKey => call('resolve-browser-view-resources', {screenKey}, 10000),
    observeBrowserController: () => call('observe-browser-controller', {}, 10000),
    loadBrowserController: () => browserControllerLoad && ownedBrowser && Date.parse(appUserDescriptor?.expiresAt)>Date.now()
      ? call('load-browser-controller', {}, 40000)
      : Promise.reject(new Error('debug_odc_native_browser_controller_load_not_ready')),
    loadBrowserExceptionController: () => browserControllerLoad && ownedBrowser && Date.parse(appUserDescriptor?.expiresAt)>Date.now()
      ? call('load-browser-exception-controller', {}, 40000)
      : Promise.reject(new Error('debug_odc_native_browser_controller_load_not_ready')),
    loadBrowserView: screenKey => browserControllerLoad && ownedBrowser && Date.parse(appUserDescriptor?.expiresAt)>Date.now()
      ? call('load-browser-view', {screenKey}, 120000)
      : Promise.reject(new Error('debug_odc_native_browser_controller_load_not_ready')),
    loadBrowserMessages: () => browserControllerLoad && ownedBrowser && Date.parse(appUserDescriptor?.expiresAt)>Date.now()
      ? call('load-browser-messages', {}, 40000)
      : Promise.reject(new Error('debug_odc_native_browser_controller_load_not_ready')),
    startBrowserInspection: () => inspection ? call('start-browser-inspection', {}, 10000)
      : Promise.reject(new Error('debug_native_client_not_configured')),
    mountBrowser: () => browserMount && inspection && browserInspectionExpiresAt > Date.now()
      ? call('mount-browser', {}, browserInspectionExpiresAt-Date.now()+10000)
      : Promise.reject(new Error('debug_odc_native_browser_execution_unqualified')),
    waitForBrowserReady: () => browserMount && inspection && browserInspectionExpiresAt > Date.now()
      ? call('wait-browser-ready', {}, browserInspectionExpiresAt-Date.now()+10000)
      : Promise.reject(new Error('debug_odc_native_browser_execution_unqualified')),
    // One original in-app navigation ({screenKey, inputs}) or navigateBack ({back:true}).
    // The worker journals each submission and result here; a lost reply is never resent.
    navigateBrowser(input) {
      if (!browserNavigation || !inspection || !(browserInspectionExpiresAt > Date.now()))
        return Promise.reject(new Error('debug_odc_native_browser_navigation_not_ready'));
      const plain = v => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
      const back = plain(input) && input.back === true && Object.keys(input).length === 1;
      const forward = plain(input) && Object.keys(input).length === 2 && input.screenKey === mountAuthorization.navigation.screenKey &&
        plain(input.inputs) && Object.values(input.inputs).every(v => typeof v === 'string');
      if (!back && !forward) return Promise.reject(new Error('debug_odc_native_browser_navigation_input_invalid'));
      return call('navigate-browser', back ? { back: true } : { screenKey: input.screenKey, inputs: { ...input.inputs } }, browserInspectionExpiresAt - Date.now() + 10000);
    },
    // One trusted click per authorized interaction index; the worker journals the
    // submission and outcome here. A lost reply is never resent.
    interactBrowser(index) {
      if (!browserInteraction || !inspection || !(browserInspectionExpiresAt > Date.now()))
        return Promise.reject(new Error('debug_odc_native_browser_interaction_not_ready'));
      if (!Number.isInteger(index) || index < 0 || index >= interactionAuthorization.length)
        return Promise.reject(new Error('debug_odc_native_browser_interaction_input_invalid'));
      return call('interact-browser', { index }, browserInspectionExpiresAt - Date.now() + 10000);
    },
    // Read-only SDK error-page state after the lifecycle settles.
    observeBrowserErrorPage: () => browserMount && inspection ? call('observe-browser-error-page', {}, 15000)
      : Promise.reject(new Error('debug_odc_native_browser_execution_unqualified')),
    // Read-only DOM evidence from the worker, compared here with the session's
    // own native reads. Only booleans leave this process.
    async observeBrowserRender() {
      if (!browserMount || !inspection) throw new Error('debug_odc_native_browser_execution_unqualified');
      const { targets, observation } = await call('observe-browser-render', {}, 15000) ?? {};
      return compareNativeRenderEvidence({ targets, observation, lastRead });
    },
    prepareBrowser(input) {
      const receipt = ownedBrowser?.receipt();
      if (receipt?.ready !== true || receipt.cleanupConfirmed === true || Date.parse(receipt.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(receipt.expiresAt)))
        return Promise.reject(new Error('debug_odc_native_browser_owner_invalid'));
      if (browserMount && mountAuthorization.runtimeUrl !== input.runtime?.runtimeUrl)
        return Promise.reject(new Error('debug_odc_browser_mount_authorization_invalid'));
      return call('prepare-browser', {runtime:input.runtime,binding:input.binding,controllerLoad:browserControllerLoad,...(browserMount ? {mountAuthorization} : {}),...(browserInteraction ? {interactionAuthorization} : {}),
        browser:{url:ownedBrowser.inspectionUrl,scope:'owned-browser-process',purpose:browserMount ? 'authorized-mount' : browserAuthentication ? 'authenticated-preparation' : 'preparation-only',expiresAt:receipt.expiresAt}},120000);
    },
    async authenticate(descriptor) {
      const result = await call('authenticate', { descriptor }, 120000);
      if (result?.authenticated === true && result.identityMatches === true) appUserDescriptor = descriptor;
      return result;
    },
    invoke: input => call('invoke', input, (serverInspectionExpiresAt === undefined
      ? input.timeoutSeconds * 1000 : Math.max(1, serverInspectionExpiresAt - Date.now())) + 10000),
    reconcileCleanup: input => call('reconcile-cleanup', input, 60000),
    async dispose() {
      let inspectionClosed = true, privateChannelClosed = true;
      try { await inspection?.close(); } catch { inspectionClosed = false; }
      // A failed private-channel cleanup must not skip worker/browser teardown
      // or hide their independently observed outcomes.
      try { await hostPrivateChannel?.close(); } catch { privateChannelClosed = false; }
      finally { appUserDescriptor = undefined; scopeRefs.clear(); lastReads.clear(); }
      if (disposed) return { completed: false }; disposed = true;
      let result;
      try { result = await call('dispose', {}, 30000); }
      catch { result = { completed: false }; }
      finally { try { child.stdin.end(); } catch { /* still observe child close and dispose the owned browser */ } }
      let timer; const exited = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(false); }, 5000); })]); clearTimeout(timer);
      const browser = await closeBrowser();
      return { ...result, workerExited: exited, inspectionClosed, privateChannelClosed,
        nativeCleanupConfirmed: result?.completed === true,
        ...(ownedBrowser ? {ownedBrowserCleanup:browser} : {}),
        completed: result?.completed === true && exited && inspectionClosed && privateChannelClosed && browser.completed === true };
    },
  };
}

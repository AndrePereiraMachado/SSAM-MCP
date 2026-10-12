// Private process: tokens are read only here, never sent to the parent.
import readline from 'node:readline';
import { createOdcNativeHost } from './debug-odc-native-host.mjs';
import { openOdcAppUserSession } from './debug-app-user-worker.mjs';
import { privateAppUserValues } from './debug-runtime.mjs';
import { reconcileOdcNativeCleanup } from './debug-odc-native-evidence.mjs';
import {createOdcNativeBrowserHost} from './debug-odc-native-browser-host.mjs';
import {connectOdcWorkerBrowser} from './debug-odc-worker-browser.mjs';
import {isOdcMountRequest} from './debug-odc-browser-mount.mjs';
import {isNativeInteractionAuthorization} from './debug-native-browser-interaction.mjs';

let host, browserPreparationOnly = false, browserAuthentication = false, browserMount = false, browserControllerLoad = false, sequence = 0, queue = Promise.resolve();
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const journal = (op, metadata) => new Promise(resolve => {
  const id = 'request-' + (++sequence); pending.set(id, resolve); send({id, op, metadata});
});
const input = readline.createInterface({ input: process.stdin });
const safeError = error => /^debug_(odc_native|odc_browser|app_user)_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_native_worker_failed';
input.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.op === 'request-approved') { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message.accepted === true); return; }
  queue = queue.then(async () => {
    try {
      let result;
      if (browserPreparationOnly && !['dispose','observe-browser-startup','observe-browser-controller','resolve-browser-view-resources',...(browserAuthentication ? ['authenticate','configure-inspection','start-browser-inspection'] : []),...(browserMount ? ['mount-browser','wait-browser-ready','observe-browser-render','navigate-browser','interact-browser','observe-browser-error-page'] : []),...(browserControllerLoad ? ['load-browser-controller','load-browser-exception-controller','load-browser-view','load-browser-messages'] : [])].includes(message.op)) throw new Error('debug_odc_native_browser_execution_unqualified');
      if (message.op === 'prepare-browser') {
        if (host) throw new Error('debug_odc_native_worker_already_prepared');
        browserPreparationOnly = true;
        browserMount = message.input.browser.purpose === 'authorized-mount';
        // The host composes the final mount record itself after authentication and inspector start.
        if (browserMount !== (message.input.mountAuthorization !== undefined) || browserMount && (!isOdcMountRequest(message.input.mountAuthorization) ||
            message.input.mountAuthorization.runtimeUrl !== message.input.runtime?.runtimeUrl))
          throw new Error('debug_odc_browser_mount_authorization_invalid');
        // Click targets only inside an authorized mount, as resolved and recorded before the browser existed.
        if (message.input.interactionAuthorization !== undefined && (!browserMount || !isNativeInteractionAuthorization(message.input.interactionAuthorization)))
          throw new Error('debug_odc_browser_interaction_authorization_invalid');
        const browser = await connectOdcWorkerBrowser(message.input.browser);
        browserAuthentication = browserMount || message.input.browser.purpose === 'authenticated-preparation';
        browserControllerLoad = browserAuthentication && message.input.controllerLoad === true;
        try { host = await createOdcNativeBrowserHost({...message.input,host:browser,
          ...(browserAuthentication ? {
            beforeSync:async metadata => ({recorded:await journal('before-browser-sync',metadata)}),
            recordSyncResult:async metadata => ({recorded:await journal('browser-sync-result',metadata)}),
          } : {}),...(browserControllerLoad ? {
            beforeControllerLoad:async metadata => ({recorded:await journal('before-browser-controller-load',metadata)}),
            recordControllerLoadOutcome:async metadata => ({recorded:await journal('browser-controller-load-result',metadata)}),
          } : {}),...(browserMount ? {
            beforeMount:async metadata => ({recorded:await journal('before-browser-mount',metadata)}),
            recordMountOutcome:async metadata => ({recorded:await journal('browser-mount-result',metadata)}),
          } : {}),...(browserMount && message.input.mountAuthorization.navigation ? {
            beforeNavigate:async metadata => ({recorded:await journal('before-browser-navigation',metadata)}),
            recordNavigationOutcome:async metadata => ({recorded:await journal('browser-navigation-result',metadata)}),
          } : {}),...(browserMount && message.input.interactionAuthorization ? {
            beforeInteraction:async metadata => ({recorded:await journal('before-browser-interaction',metadata)}),
            recordInteractionOutcome:async metadata => ({recorded:await journal('browser-interaction-result',metadata)}),
          } : {})}); }
        catch(error) { await browser.dispose(); throw error; }
        result = {prepared:true,executionQualified:false,receipt:host.receipt()};
      } else if (message.op === 'observe-browser-startup') {
        if (!browserPreparationOnly || !host) throw new Error('debug_odc_native_browser_not_prepared');
        result = await host.observeStartup();
      } else if (message.op === 'resolve-browser-view-resources') {
        if (!browserPreparationOnly || !host) throw new Error('debug_odc_native_browser_not_prepared');
        result = await host.resolveViewResources(message.input.screenKey);
      } else if (message.op === 'observe-browser-controller') {
        if (!browserPreparationOnly || !host) throw new Error('debug_odc_native_browser_not_prepared');
        result = await host.observeApplicationController();
      } else if (message.op === 'load-browser-controller') {
        if (!browserControllerLoad || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.loadApplicationController();
      } else if (message.op === 'load-browser-exception-controller') {
        if (!browserControllerLoad || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.loadGlobalExceptionController();
      } else if (message.op === 'load-browser-view') {
        if (!browserControllerLoad || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.loadView(message.input.screenKey);
      } else if (message.op === 'load-browser-messages') {
        if (!browserControllerLoad || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.loadMessages();
      } else if (message.op === 'start-browser-inspection') {
        if (!browserPreparationOnly || !browserAuthentication || !host) throw new Error('debug_odc_native_browser_not_prepared');
        result = await host.startInspection();
      } else if (message.op === 'mount-browser') {
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.mount();
      } else if (message.op === 'wait-browser-ready') {
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.waitForApplicationReady();
      } else if (message.op === 'observe-browser-render') {
        // Read-only DOM snapshot; the parent compares it with its own native reads.
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.observeRender();
      } else if (message.op === 'navigate-browser') {
        // One original in-app navigation or navigateBack; the host journals and refuses a full reload.
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = message.input?.back === true ? await host.navigateBack() : await host.navigate(message.input?.screenKey, message.input?.inputs);
      } else if (message.op === 'interact-browser') {
        // One trusted CDP click in the owned page; the host journals and never resends.
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.interact(message.input?.index);
      } else if (message.op === 'observe-browser-error-page') {
        if (!browserMount || !host) throw new Error('debug_odc_native_browser_execution_unqualified');
        result = await host.observeErrorPage();
      } else if (message.op === 'prepare') {
        if (host) throw new Error('debug_odc_native_worker_already_prepared');
        host = await createOdcNativeHost({ ...message.input, beforeRequest: metadata => new Promise(resolve => {
          const id = 'request-' + (++sequence); pending.set(id, resolve); send({ id, op: 'before-request', metadata });
        }) }); result = { prepared: true, ...host.validateScenarios(message.input.calls ?? []), receipt: host.receipt() };
      } else if (message.op === 'reconcile-cleanup') {
        if (host) throw new Error('debug_odc_native_worker_already_prepared');
        result = await reconcileOdcNativeCleanup(message.input);
      } else if (message.op === 'authenticate') {
        const descriptor = message.input.descriptor;
        const session = await openOdcAppUserSession(descriptor);
        if (browserPreparationOnly) result = await host.authenticate(session, descriptor);
        else {
          const secrets = await privateAppUserValues(descriptor, descriptor.binding);
          result = await host.authenticate(session, descriptor, secrets);
        }
      } else if (message.op === 'configure-server-inspection') result = await host.configureServerInspection(message.input);
      else if (message.op === 'configure-inspection') result = await host.configureInspection(message.input);
      else if (message.op === 'invoke') result = await host.invoke(message.input);
      else if (message.op === 'dispose') { result = { ...(host ? await host.dispose() : { completed: true }), receipt: host?.receipt() }; }
      else throw new Error('debug_odc_native_worker_operation_invalid');
      send({ id: message.id, ok: true, result });
      if (message.op === 'dispose') { input.close(); process.stdin.destroy(); }
    } catch (error) { send({ id: message.id, ok: false, error: safeError(error) }); }
  });
});
input.on('close', () => { for (const resolve of pending.values()) resolve(false); pending.clear(); void host?.dispose(); });

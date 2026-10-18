// Mounted ODC screen through the ORIGINAL bootstrap (decision of 2026-10-10,
// option B). The published app runs in an owned headless Chrome whose network is
// denied except for the guarded host transports. Assets are the published,
// hash-pinned revision; the native inspector is configured after the app-user
// sign-in and started before the final bootstrap stage, which is the first one
// that imports screen controllers or runs application lifecycle code.
//
// The barrier is the user's Development authorization (words recorded before
// the browser exists). It is NOT a static proof of every SDK effect, so every
// record keeps staticEffectsQualified:false. No evaluator, no forced flags, no
// lifecycle hook is called by hand: the original router mounts the default
// screen (or a qualified named route as a deep link) and, per scenario, the
// original SDK navigateTo/navigateBack move to an authorized target and back.
// run.interactions add one trusted CDP click per authorized widget in this
// owned page (never a Studio or the user's browser), after the lifecycle settles.
// The native debugger observes what that original code does. A handled
// lifecycle exception through the SDK error page is a known native failure.
import { wordsGiven } from './destructive-operations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';
import { odcMountPolicy } from './debug-odc-browser-mount.mjs';
import { odcScreenQuery } from './debug-odc-browser-navigation.mjs';
import { isNativeInteractionAuthorization } from './debug-native-browser-interaction.mjs';

const fail = code => { throw new Error('debug_odc_native_mount_' + code); };
const KEY = /^[A-Za-z0-9_+]{22}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1)); fs.renameSync(file + '.tmp', file); };
const publicError = error => error?.code === 'EEXIST' ? 'debug_odc_native_mount_binding_busy'
  : /^debug_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_native_mount_failed';

// Declared, non-absent screen and block handlers against the native stop
// identities (moduleKey:functionKey per stop, in stop order). No values.
export function odcHandlerCoverage(mount, moduleKey, functions = []) {
  const observed = [], notObserved = [], absent = [], list = Array.isArray(functions) ? functions : [];
  for (const view of Array.isArray(mount?.views) ? mount.views : []) {
    for (const handler of view.absentHandlers ?? []) absent.push({ viewKey: view.key, handler });
    for (const h of view.handlers ?? []) {
      const identity = moduleKey + ':' + h.actionKey, indexes = list.flatMap((f, i) => f === identity ? [i] : []);
      if (indexes.length) observed.push({ viewKey: view.key, handler: h.handler, actionKey: h.actionKey, stops: indexes.length, firstIndex: indexes[0], lastIndex: indexes.at(-1) });
      else notObserved.push({ viewKey: view.key, handler: h.handler, actionKey: h.actionKey });
    }
  }
  // Flow exception handlers that stopped (the global OnException belongs to the startup chunks).
  const startupKeys = Array.isArray(mount?.startup?.actionKeys) ? mount.startup.actionKeys : [], exceptionHandlers = [];
  for (const identity of new Set(list)) {
    const functionKey = typeof identity === 'string' && identity.startsWith(moduleKey + ':') ? identity.slice(moduleKey.length + 1) : '';
    if (!functionKey.endsWith('.#FlowExceptionHandler')) continue;
    const indexes = list.flatMap((f, i) => f === identity ? [i] : []);
    exceptionHandlers.push({ functionKey, global: startupKeys.includes(functionKey), stops: indexes.length, firstIndex: indexes[0], lastIndex: indexes.at(-1) });
  }
  return { declared: observed.length + notObserved.length, observed, notObserved, absent, exceptionHandlers };
}
// Recomputed from the per-binding DOM/native verdicts, not from a bare flag.
function renderVerifiedFrom(render) {
  return render?.renderVerified === true && Array.isArray(render.reasons) && !render.reasons.length &&
    Array.isArray(render.roots) && render.roots.length > 0 && render.roots.every(r => r?.present === true) &&
    Array.isArray(render.bindings) && render.bindings.length > 0 &&
    render.bindings.every(b => b?.present === true && b.unique === true && b.nativeRead === true && b.typeSupported === true && b.matches === true);
}
// lifecycleComplete is never set: every reason below must be absent. OnDestroy
// counts only from a stop after an authorized in-app navigation.
export function odcLifecycleCompletion(report) {
  const reasons = [], coverage = report.handlerCoverage, navigation = report.navigation;
  if (!(coverage?.declared > 0)) reasons.push('handlers-undeclared');
  else if (coverage.notObserved?.length) reasons.push('handlers-not-observed');
  if (!(navigation?.authorized === true && navigation.completed === true && Number.isInteger(navigation.functionsBefore))) reasons.push('navigation-unavailable');
  else if ((coverage?.observed ?? []).concat(coverage?.notObserved ?? []).filter(h => h.handler === 'onDestroyEventHandler')
    .some(h => !(h.stops > 0 && h.lastIndex >= navigation.functionsBefore))) reasons.push('on-destroy-not-observed-after-navigation');
  if (report.renderVerified !== true) reasons.push('render-unverified');
  if (report.lifecycleSettled !== true) reasons.push('lifecycle-unsettled');
  if (report.cleanup?.completed !== true) reasons.push('cleanup-incomplete');
  if (report.credentialsReleased !== true) reasons.push('credentials-unreleased');
  if (report.lockRetained !== false) reasons.push('lock-retained');
  if (report.uncertain !== false) reasons.push('uncertain');
  if (report.state !== 'answered') reasons.push('run-not-answered');
  return { lifecycleComplete: reasons.length === 0, lifecycleIncompleteReasons: reasons };
}

// Installed Chrome only; the profile, process and network guard are owned per run.
export function odcChromeExecutable(env = process.env) {
  const candidates = [env.SSAM_DEBUG_CHROME,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  const found = candidates.find(file => file && path.isAbsolute(file) && fs.existsSync(file));
  if (!found) fail('browser_unavailable');
  return found;
}

export async function runOdcNativeMount(input, prepared, readers, services = {}) {
  // Refusals that need no live state come before the lock and any download.
  if (services.requireClientInspection !== true) fail('client_inspection_required');
  if (!wordsGiven(input.words)) fail('explicit_authorization_required'); // CX15 r7: one predicate
  // Screen inputs exist only as the URL query of an authorized navigation target
  // (one navigation per scenario) or of the initial deep link (one scenario).
  const navigation = prepared.mount?.navigation, route = prepared.mount?.route, deepLink = route?.default === false;
  const screenOnly = c => c === undefined || c !== null && typeof c === 'object' && Object.keys(c).every(k => k === 'screen') &&
    Object.keys(c.screen ?? {}).every(k => k === 'inputs');
  const canonical = n => { try { return typeof n?.query === 'string' && odcScreenQuery(n.inputs).query === n.query && sha(n.query) === n.querySha256; } catch { return false; } };
  const segment = v => /^[A-Za-z0-9_-]+$/.test(v ?? '');
  const entryInputs = prepared.scenarios.some(s => Object.keys(s.inputs ?? {}).length);
  if (navigation ? deepLink || navigation.back !== true || !KEY.test(navigation.screenKey ?? '') || !segment(navigation.segment) || entryInputs ||
      !screenOnly(input.context) || prepared.scenarios.some(s => !screenOnly(s.context) || !canonical(s.navigation))
    : deepLink ? prepared.scenarios.length !== 1 || !segment(route.segment) || typeof route.query !== 'string' || sha(route.query) !== route.querySha256 ||
      entryInputs || !screenOnly(input.context) || prepared.scenarios.some(s => !screenOnly(s.context))
    : input.context !== undefined || prepared.scenarios.length > 1 || prepared.scenarios.some(s => s.context !== undefined || Object.keys(s.inputs ?? {}).length))
    fail('screen_inputs_unsupported');
  // Resolved click targets from prepareOdcMountInteractions: 1..10, strict shape.
  const interactions = prepared.mount?.interactions;
  if (interactions !== undefined && !isNativeInteractionAuthorization(interactions)) fail('interactions_invalid');
  const binding = readers.binding, screenKey = prepared.mount?.screenKey;
  if (!KEY.test(screenKey ?? '')) fail('screen_required');
  if (!binding?.environmentKey || !KEY.test(binding.moduleKey ?? '') || !/^https:\/\/[^/]+\/.+\/$/.test(binding.runtimeUrl ?? '')) fail('development_binding_required');
  if (!/^[a-f0-9]{64}$/i.test(readers.sourceContract?.sha256 ?? '')) fail('model_source_required');
  const root = services.root ?? workspaceRoot, base = path.join(root, '.local', 'debugger');
  const sessionId = services.sessionId ?? randomUUID().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(sessionId)) fail('session_id_invalid');
  const operationId = randomUUID(), id = sha('odc|' + binding.runtimeUrl + '|' + binding.moduleKey);
  const dir = path.join(base, 'native-runs', 'odc', operationId), lock = path.join(base, 'native-runs', id + '.lock');
  const latest = path.join(base, 'native-runs', 'odc', id + '.json');
  const settleMs = services.settleMs ?? 3000, pollMs = services.pollMs ?? 100;
  const report = { schema: 'ssam-odc-native-run/1', operationId, sessionId, lane: 'odc', execution: 'native-entry', lifecycle: 'mounted',
    mountPolicy: odcMountPolicy, staticEffectsQualified: false, binding, entry: prepared.entry, screenKey, state: 'preparing',
    startedAt: new Date().toISOString(), receiptPath: path.join(dir, 'receipt.json'), results: [],
    lifecycleComplete: false, renderVerified: false, appRequestIdentityProved: false, userRequestIsolationProved: false,
    route: deepLink ? { default: false, segment: route.segment, querySha256: route.querySha256 } : { default: true } };
  const authorizedNavigation = navigation && { screenKey: navigation.screenKey, segment: navigation.segment, back: true,
    scenarios: prepared.scenarios.map(s => ({ name: s.name, inputsSha256: s.navigation.querySha256 })) };
  const save = () => { write(report.receiptPath, report); write(latest, report); };
  // Each journal entry is written once (wx): a lost reply can never be re-recorded as a fresh submission.
  const journal = (name, apply) => async metadata => {
    try { fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ operationId, at: new Date().toISOString(), metadata }), { flag: 'wx', flush: true }); }
    catch { return { recorded: false }; }
    apply(metadata); save(); return { recorded: true };
  };
  // Per-scenario navigation journals: <scenario>/navigation-* and back-*, each written once.
  let step;
  const scenarioDir = (s, i) => path.join(dir, 'scenarios', /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,80}$/.test(s.name ?? '') ? s.name : 'scenario-' + (i + 1));
  const stepJournal = phase => async metadata => {
    const target = step; if (!target) return { recorded: false };
    const direction = metadata?.direction === 'back' ? 'back' : 'forward', name = (direction === 'back' ? 'back' : 'navigation') + '-' + phase;
    try { fs.mkdirSync(target.dir, { recursive: true });
      fs.writeFileSync(path.join(target.dir, name + '.json'), JSON.stringify({ operationId, scenario: target.name, at: new Date().toISOString(), metadata }), { flag: 'wx', flush: true }); }
    catch { return { recorded: false }; }
    target[direction] = { ...target[direction], ...(phase === 'submission' ? { submitted: true } : { outcome: metadata }) }; save(); return { recorded: true };
  };
  // Per-interaction journals: interactions/<n>/interaction-submission|result.json, each written once.
  let interactionStep;
  const interactionJournal = phase => async metadata => {
    const target = interactionStep; if (!target) return { recorded: false };
    try { fs.mkdirSync(target.dir, { recursive: true });
      fs.writeFileSync(path.join(target.dir, 'interaction-' + phase + '.json'), JSON.stringify({ operationId, index: target.index, at: new Date().toISOString(), metadata }), { flag: 'wx', flush: true }); }
    catch { return { recorded: false }; }
    if (phase === 'submission') target.submitted = true; else target.outcome = metadata;
    save(); return { recorded: true };
  };
  async function verifyPublication(phase) {
    try { await readers.verifyPublication?.(); }
    catch (error) { report.failurePhase = phase; throw /^debug_[a-z_]+$/.test(error?.message ?? '') ? error : new Error('debug_odc_native_mount_publication_check_failed'); }
  }
  let ownsLock = false, uncertain = false, browser, broker, descriptor;
  try {
    for (const blocker of [path.join(base, 'blocked-bindings', id + '.json'), path.join(base, 'native-background-bindings', id + '.lock'),
      path.join(base, 'native-endpoint-bindings', id + '.lock')]) if (fs.existsSync(blocker)) fail('binding_blocked');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const fd = fs.openSync(lock, 'wx'); ownsLock = true;
    try { fs.writeFileSync(fd, JSON.stringify({ operationId, sessionId, kind: 'authorized-mount' })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.mkdirSync(dir, { recursive: true });
    const authorizationFile = path.join(dir, 'authorization.json');
    // CX15 r5 (N-3): the file keeps wordsSha256 of the user's words, never the words (authorizationSha256 = sha of the file).
    fs.writeFileSync(authorizationFile, JSON.stringify({ schema: 'ssam-odc-mount-authorization/1', policy: odcMountPolicy, operationId,
      wordsSha256: sha(String(input.words)), tenant: binding.tenant, module: binding.module, moduleKey: binding.moduleKey, runtimeUrl: binding.runtimeUrl,
      environmentKey: binding.environmentKey, revision: binding.revision, screenKey, sourceSha256: readers.sourceContract.sha256.toLowerCase(),
      route: report.route, ...(authorizedNavigation ? { navigation: authorizedNavigation } : {}), ...(interactions ? { interactions } : {}),
      at: new Date().toISOString() }), { flag: 'wx', flush: true });
    const authorizationSha256 = sha(fs.readFileSync(authorizationFile));
    report.authorizationSha256 = authorizationSha256; save();
    const runtime = await (services.acquire ?? (await import('./debug-odc-native-assets.mjs')).acquireOdcNativeAssets)(binding, path.join(dir, 'assets'));
    if (runtime.runtimeUrl !== binding.runtimeUrl) fail('runtime_url_mismatch');
    if (readers.runtime?.moduleVersion && runtime.moduleVersion !== readers.runtime.moduleVersion) fail('publication_changed');
    const styles = await (services.acquireStyles ?? (await import('./debug-odc-browser-styles.mjs')).acquireOdcDocumentStyles)(runtime, path.join(dir, 'styles'));
    Object.assign(runtime.pins, styles.pins);
    report.assets = { moduleVersion: runtime.moduleVersion, pins: Object.fromEntries(Object.entries(runtime.pins).map(([name, pin]) => [name, pin.sha256])) };
    await verifyPublication('publication-before-browser');
    report.state = 'preparing-browser'; save();
    browser = await (services.launchBrowser ?? (await import('./debug-native-browser-host.mjs')).launchNativeDebugBrowser)({
      directory: path.join(dir, 'browser'), executable: services.chromeExecutable ?? odcChromeExecutable(), leaseMs: 900000 });
    broker = (services.broker ?? (await import('./debug-odc-native-broker.mjs')).createOdcNativeBroker)({ ownedBrowser: browser,
      mountAuthorization: { policy: odcMountPolicy, authorizationSha256, runtimeUrl: binding.runtimeUrl, screenKey,
        ...(deepLink ? { route: { segment: route.segment, query: route.query, querySha256: route.querySha256 } } : {}),
        ...(navigation ? { navigation: { screenKey: navigation.screenKey, segment: navigation.segment, back: true,
          inputsSha256: [...new Set(prepared.scenarios.map(s => s.navigation.querySha256))] } } : {}) },
      beforeBrowserSync: journal('sync-submission', () => { report.syncSubmitted = true; }),
      recordBrowserSyncResult: journal('sync-result', result => { report.syncResult = result; }),
      beforeBrowserMount: journal('mount-submission', () => { report.mountSubmitted = true; }),
      recordBrowserMountResult: journal('mount-result', outcome => { report.mountOutcome = outcome; }),
      ...(navigation ? { beforeBrowserNavigation: stepJournal('submission'), recordBrowserNavigationResult: stepJournal('result') } : {}),
      ...(interactions ? { interactionAuthorization: interactions, beforeBrowserInteraction: interactionJournal('submission'),
        recordBrowserInteractionResult: interactionJournal('result') } : {}) });
    const modelSources = await readers.clientInspectionModels?.() ?? [];
    const browserPrepared = await broker.prepareBrowser({ runtime, binding, prepared, modelSources });
    report.browser = { prepared: browserPrepared?.prepared === true, initialized: browserPrepared?.receipt?.initialized === true };
    // Every lazily declared view resource must already be pinned; nothing is fetched unpinned.
    const resources = await broker.resolveBrowserViewResources(screenKey);
    report.viewResources = { pinned: resources?.viewResourcesPinned === true, count: resources?.resources?.length ?? 0 };
    if (!report.viewResources.pinned) fail('view_resources_unpinned');
    report.state = 'sign-in'; save();
    const entered = await (services.prepareUser ?? (await import('./debug-app-user.mjs')).prepareDebugAppUser)({ ...binding, lane: 'odc', seconds: 600 }, { sessionId });
    if (!entered?.ok) { report.state = entered?.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; return report; }
    descriptor = entered.descriptor;
    const sameTarget = services.sameTarget ?? (async () => { const m = await import('./debug-app-user.mjs');
      return m.sameAppUserTarget(descriptor?.binding, m.appUserBinding({ ...binding, lane: 'odc' }, sessionId)); });
    if (!await sameTarget()) fail('app_user_scope_mismatch');
    // In a client session this also configures the native inspector with the selected breakpoints.
    const authenticated = await broker.authenticate(descriptor);
    if (authenticated?.authenticated !== true || authenticated.identityMatches !== true) fail('native_identity_unproved');
    report.authentication = authenticated;
    if (broker.inspectionActivity?.().configured !== true) fail('inspection_not_configured');
    await verifyPublication('publication-before-mount');
    report.state = 'mounting'; save();
    try { report.mount = await broker.mountBrowser(); }
    catch (error) {
      // Only a durably recorded, confirmed reply makes the outcome known.
      const outcome = report.mountOutcome;
      uncertain = report.mountSubmitted === true && !(typeof outcome?.invoked === 'boolean' && outcome.transportUnconfirmed !== true);
      throw error;
    }
    report.state = 'waiting-ready'; save();
    let ready;
    report.errorPage = { navigated: false, marked: null, valuesRead: false };
    // The original error path (handleError -> navigateToErrorPage), read-only. With
    // an exception stop it is a known native failure, not uncertainty.
    const errorPath = async phase => {
      const exceptions = (broker.inspectionActivity().exceptions ?? []).map(e => ({ function: e.function ?? null, type: e.type ?? 'unknown' }));
      if (!exceptions.length && ready?.errorPageObserved !== true) return;
      let observed;
      try { observed = typeof broker.observeBrowserErrorPage === 'function' ? await broker.observeBrowserErrorPage() : undefined; } catch { observed = undefined; }
      const navigated = report.errorPage.navigated || observed?.navigated === true || observed?.historyNavigated === true;
      const marked = report.errorPage.marked === true || observed?.marked === true;
      const known = report.errorPage.marked === false || observed?.marked === false;
      report.errorPage = { navigated, marked: marked ? true : known ? false : null, observed: observed?.observed === true, valuesRead: false };
      if (exceptions.length) report.exceptionStops = exceptions;
      if (!navigated && !marked) return;
      report.lifecycleException = { phase, knownNativeFailure: true, exceptionStops: exceptions.length, exceptions, errorPage: { navigated, marked } };
      // Error page without an exception stop (e.g. no pauseOnExceptions): still the original error path.
      fail(exceptions.length ? 'lifecycle_exception' : 'error_page_observed');
    };
    // A failed ready wait (lost reply, error navigation) still reads the original error
    // path; without an exception stop and its evidence the ready error stands.
    try { ready = await broker.waitForBrowserReady(); }
    catch (error) { await errorPath('ready'); throw error; }
    report.applicationReady = ready?.nativeApplicationReady === true && ready.nativePromiseCompleted === true;
    report.errorPage = { navigated: ready?.errorPage?.navigated === true, marked: typeof ready?.errorPage?.marked === 'boolean' ? ready.errorPage.marked : null, valuesRead: false };
    // Lifecycle hooks after ready (OnReady, OnRender, blocks) pause the original
    // code cooperatively. Hold the session until those pauses resume and stay quiet.
    report.state = 'observing-lifecycle'; save();
    const deadline = Date.parse(descriptor.expiresAt);
    const settle = async () => {
      let activity = broker.inspectionActivity();
      while (!activity.ended && Date.now() < deadline && (activity.paused || Date.now() - activity.lastChangeAt < settleMs)) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        activity = broker.inspectionActivity();
      }
      return { activity, settled: !activity.ended && !activity.paused && Date.now() - activity.lastChangeAt >= settleMs };
    };
    const { activity, settled } = await settle();
    report.lifecycleSettled = settled;
    report.inspection = { stops: activity.stops, paused: activity.paused, ended: activity.ended === true };
    // The navigation target's own handlers (OnDestroy on back) are covered too.
    const views = [...(prepared.mount.views ?? [])];
    for (const view of navigation?.views ?? []) if (!views.some(v => v.key === view.key)) views.push(view);
    const coverage = functions => odcHandlerCoverage({ views, startup: prepared.mount.startup }, binding.moduleKey, functions);
    report.handlerCoverage = coverage(activity.functions);
    await errorPath('lifecycle');
    // Read-only DOM evidence once the lifecycle is quiet, compared by the broker
    // with the session's own native reads. A failed observation is unverified, not a failure.
    if (report.lifecycleSettled) {
      try { report.render = typeof broker.observeBrowserRender === 'function' ? await broker.observeBrowserRender()
        : { renderVerified: false, error: 'debug_odc_native_mount_render_unavailable' }; }
      catch (error) { report.render = { renderVerified: false, error: publicError(error) }; }
    }
    report.renderVerified = renderVerifiedFrom(report.render);
    report.results.push({ name: navigation ? 'mount' : prepared.scenarios[0]?.name ?? 'mount', ok: report.applicationReady && report.lifecycleSettled,
      startupCallbackReturned: report.mount?.startupCallbackReturned === true, applicationReady: report.applicationReady,
      lifecycleSettled: report.lifecycleSettled, nativeStops: activity.stops, lifecycleComplete: false, renderVerified: report.renderVerified });
    // One trusted click per authorized interaction: submission (wx) -> click -> result
    // -> settle. A lost reply is uncertain, keeps the lock and is never resent.
    if (interactions && report.results[0].ok) {
      report.interactions = [];
      for (const [i, interaction] of interactions.entries()) {
        const target = interactionStep = { index: i, dir: path.join(dir, 'interactions', String(i + 1)) };
        const functionsBefore = broker.inspectionActivity().functions.length;
        report.state = 'interacting'; save();
        let click;
        try { click = await broker.interactBrowser(i); }
        catch (error) {
          uncertain ||= target.submitted === true && !(target.outcome?.dispatched === true && target.outcome.transportUnconfirmed === false);
          throw error;
        }
        const after = await settle(); interactionStep = undefined;
        const entry = { index: i, target: interaction.target, name: interaction.name, actionKey: interaction.actionKey,
          dispatched: click?.dispatched === true && target.outcome?.dispatched === true, trusted: click?.trusted === true, settled: after.settled, functionsBefore,
          handlerObserved: broker.inspectionActivity().functions.slice(functionsBefore).includes(binding.moduleKey + ':' + interaction.actionKey) };
        report.interactions.push(entry);
        report.results.push({ name: 'interaction-' + (i + 1), ok: entry.dispatched && entry.settled, interaction: entry, lifecycleComplete: false }); save();
        await errorPath('interaction');
        if (!report.results.at(-1).ok) break;
      }
      report.handlerCoverage = coverage(broker.inspectionActivity().functions);
    }
    // One original navigation per scenario: submission (wx) -> navigate -> result
    // -> settle -> navigateBack -> settle. A lost reply is uncertain and ends the run.
    if (navigation && report.results.every(r => r.ok)) {
      report.navigation = { authorized: true, completed: false, screenKey: navigation.screenKey, segment: navigation.segment, back: true };
      const guarded = async (target, direction, run) => {
        try { return await run(); }
        catch (error) {
          const outcome = target[direction]?.outcome;
          uncertain ||= target[direction]?.submitted === true && !(typeof outcome?.invoked === 'boolean' && outcome.transportUnconfirmed !== true);
          throw error;
        }
      };
      for (const [i, scenario] of prepared.scenarios.entries()) {
        const target = step = { name: scenario.name, dir: scenarioDir(scenario, i) };
        const functionsBefore = broker.inspectionActivity().functions.length;
        if (i === 0) report.navigation.functionsBefore = functionsBefore;
        report.state = 'navigating'; save();
        const forward = await guarded(target, 'forward', () => broker.navigateBrowser({ screenKey: navigation.screenKey, inputs: Object.fromEntries(scenario.navigation.inputs) }));
        const afterForward = await settle();
        report.state = 'navigating-back'; save();
        const back = await guarded(target, 'back', () => broker.navigateBrowser({ back: true }));
        const afterBack = await settle();
        step = undefined;
        const result = { name: scenario.name, ok: forward?.reached === true && back?.reached === true && afterForward.settled && afterBack.settled,
          navigation: { reached: forward?.reached === true, internalGoTo: forward?.internalGoTo === true, settled: afterForward.settled,
            inputsSha256: scenario.navigation.querySha256, functionsBefore },
          back: { reached: back?.reached === true, internalGoBack: back?.internalGoBack === true, settled: afterBack.settled }, lifecycleComplete: false };
        report.results.push(result); save();
        if (!result.ok) break;
      }
      report.navigation.completed = report.results.filter(r => r.navigation).length === prepared.scenarios.length && report.results.every(r => r.ok);
      report.handlerCoverage = coverage(broker.inspectionActivity().functions);
    }
    report.state = 'answered';
    return report;
  } catch (error) {
    report.state = uncertain ? 'uncertain' : 'failed'; report.error = publicError(error);
    if (error?.code === 'EEXIST' && !ownsLock) throw new Error('debug_odc_native_mount_binding_busy');
    return report;
  } finally {
    if (broker) {
      try { report.cleanup = await broker.dispose(); } catch { report.cleanup = { completed: false }; }
      uncertain ||= report.cleanup?.completed !== true;
    } else if (browser) {
      try { report.cleanup = await browser.dispose(); } catch { report.cleanup = { completed: false }; }
      uncertain ||= report.cleanup?.completed !== true;
    }
    // A submitted user sync without a confirmed answer stays unknown.
    if (report.syncSubmitted) uncertain ||= report.syncResult?.syncUncertain !== false;
    if (descriptor) {
      try { report.credentialsReleased = (await (services.releaseUser ?? (await import('./debug-app-user.mjs')).releaseDebugAppUser)(descriptor))?.ok === true; }
      catch { report.credentialsReleased = false; }
      uncertain ||= !report.credentialsReleased;
    }
    if (ownsLock) {
      report.finishedAt = new Date().toISOString(); report.uncertain = uncertain;
      if (uncertain) report.state = 'uncertain';
      report.ok = report.state === 'answered' && !uncertain && report.results.every(r => r.ok);
      report.lockRetained = uncertain;
      if (!uncertain) { try { fs.unlinkSync(lock); } catch { report.lockRetained = true; report.ok = false; } }
      // Computed last: the lock release is part of the evidence.
      Object.assign(report, odcLifecycleCompletion(report));
      for (const result of report.results) result.lifecycleComplete = report.lifecycleComplete;
      save();
    }
  }
}

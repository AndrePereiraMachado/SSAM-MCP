import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runOdcNativeMount, odcLifecycleCompletion } from '../debug-odc-native-mount-run.mjs';
import { odcMountPolicy } from '../debug-odc-browser-mount.mjs';

const runtimeUrl = 'https://fixture-dev.example.app/Fixture/', screenKey = 'W4JQW+OX20iILeFJFpMkqA';
const binding = { lane: 'odc', tenant: 'fixture.outsystems.dev', module: 'Fixture', moduleKey: '7WNw7ud8AEKh1ftGQYhllg',
  runtimeUrl, revision: 3, environmentKey: 'dev-stage' };
const blockKey = 'RDyePs1DwUyB5poRbGhwVA', M = binding.moduleKey;
const INIT = 'OzK7jk5Lo0Wu2dmagSNFog', READY = 'ALQheqsdZEGBVNun+Anl5w', DESTROY = '2anhLIl+6Um49kZrBQtuKQ', BLOCK_INIT = 'RlJ5nWDBJUGdVNVnSt55DQ', BLOCK_PARAMS = 'cPqad_ysvUugjlnIaKYBrw';
const views = [{ key: screenKey, handlers: [{ handler: 'onInitializeEventHandler', actionKey: INIT }, { handler: 'onReadyEventHandler', actionKey: READY },
  { handler: 'onDestroyEventHandler', actionKey: DESTROY }], absentHandlers: ['onParametersChangedEventHandler'] },
  { key: blockKey, handlers: [{ handler: 'onInitializeEventHandler', actionKey: BLOCK_INIT }, { handler: 'onParametersChangedEventHandler', actionKey: BLOCK_PARAMS }], absentHandlers: [] }];
const prepared = (mountViews) => ({ entry: { key: 'OzK7jk5Lo0Wu2dmagSNFog', kind: 'ScreenAction', name: 'ScreenOnInitialize' },
  scenarios: [{ name: 'scenario-1', inputs: {} }], mount: { screenKey, ...(mountViews ? { views: mountViews } : {}) }, effects: ['unknown-javascript'],
  sourceContract: { path: 'model.oml', sha256: 'A'.repeat(64) } });
const binding1 = { key: screenKey, id: 'ResultValue', variable: 'Result', present: true, unique: true, nativeRead: true, typeSupported: true, matches: true };
const verifiedRender = { renderVerified: true, reasons: [], compared: 1, roots: [{ key: screenKey, present: true }, { key: blockKey, present: true }], bindings: [binding1] };
function fixture({ mount = 'answered', viewResources = true, version = 'v1', pauses = [], functions = [], render = verifiedRender, cleanup = { completed: true },
  navigation = 'answered', navigationFunctions = {}, interaction = 'answered', interactionFunctions = [], errorPage, ready } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-mount-')), calls = [];
  let activity = { configured: false, paused: false, stops: 0, functions, lastChangeAt: null, ended: false }, brokerOptions;
  const broker = options => {
    brokerOptions = options; calls.push('broker');
    return {
      async prepareBrowser(input) { calls.push('prepare-browser'); assert.equal(input.prepared.mount.screenKey, screenKey); assert.deepEqual(input.modelSources, ['producer']); return { prepared: true, receipt: { initialized: true } }; },
      async resolveBrowserViewResources(key) { calls.push('view-resources:' + key); if (!viewResources) throw new Error('debug_odc_browser_view_resources_pin'); return { viewResourcesPinned: true, resources: [] }; },
      async authenticate() { calls.push('authenticate'); activity = { ...activity, configured: true, lastChangeAt: Date.now() }; return { authenticated: true, identityMatches: true }; },
      inspectionActivity: () => { const next = pauses.shift(); if (next) activity = { ...activity, ...next, lastChangeAt: Date.now() }; return { ...activity, functions: [...activity.functions] }; },
      async observeBrowserRender() { calls.push('render'); if (render instanceof Error) throw render; return structuredClone(render); },
      async mountBrowser() {
        calls.push('mount');
        assert.equal((await options.beforeBrowserMount({ policy: odcMountPolicy, sourceSha256: 'c'.repeat(64) })).recorded, true);
        if (mount === 'lost') throw new Error('debug_odc_native_worker_timeout');
        const outcome = mount === 'native-failed' ? { invoked: true, callbackReturned: false } : { invoked: true, callbackReturned: true };
        assert.equal((await options.recordBrowserMountResult(outcome)).recorded, true);
        if (mount === 'native-failed') throw new Error('debug_odc_browser_mount_native_mount_failed');
        return { nativeBootstrapInvoked: true, startupCallbackReturned: true, lifecycleComplete: false, mountedVerified: false };
      },
      async waitForBrowserReady() { calls.push('ready'); if (ready instanceof Error) throw ready; return ready ?? { nativeApplicationReady: true, nativePromiseCompleted: true, lifecycleComplete: false }; },
      ...(errorPage ? { async observeBrowserErrorPage() { calls.push('error-page'); return errorPage; } } : {}),
      async interactBrowser(index) {
        calls.push('interact:' + index + (activity.paused ? ':while-paused' : ''));
        if (interaction === 'hidden') throw new Error('debug_native_browser_interaction_element_hidden');
        const metadata = { sequence: index, event: 'click', id: 'SaveButton' };
        assert.equal((await options.beforeBrowserInteraction(metadata)).recorded, true);
        // The same submission can never be journaled twice.
        assert.equal((await options.beforeBrowserInteraction(metadata)).recorded, false);
        if (interaction === 'lost') throw new Error('debug_odc_native_worker_timeout');
        // The original onClick handler pauses natively.
        activity = { ...activity, paused: true, stops: activity.stops + 1, functions: [...activity.functions, ...interactionFunctions], lastChangeAt: Date.now() };
        pauses.push({}, { paused: false });
        assert.equal((await options.recordBrowserInteractionResult({ ...metadata, handlerInvoked: null, dispatched: true, trusted: true, transportUnconfirmed: false })).recorded, true);
        return { sequence: index, event: 'click', dispatched: true, trusted: true, evaluated: false };
      },
      async navigateBrowser(request) {
        const direction = request.back ? 'back' : 'forward';
        calls.push('navigate:' + direction + (request.back ? '' : ':' + JSON.stringify(request.inputs)) + (activity.paused ? ':while-paused' : ''));
        assert.equal((await options.beforeBrowserNavigation({ direction, querySha256: request.back ? undefined : 'q' })).recorded, true);
        if (navigation === 'lost' && direction === 'forward') throw new Error('debug_odc_native_worker_timeout');
        // The original lifecycle of the screen being left/entered pauses again.
        activity = { ...activity, paused: true, stops: activity.stops + 1, functions: [...activity.functions, ...(navigationFunctions[direction] ?? [])], lastChangeAt: Date.now() };
        pauses.push({}, { paused: false });
        assert.equal((await options.recordBrowserNavigationResult({ direction, invoked: true, internalGoTo: true })).recorded, true);
        return { direction, invoked: true, reached: !(navigation === 'unreached' && direction === 'forward'), fullReload: false, ...(direction === 'forward' ? { internalGoTo: true } : { internalGoBack: true }) };
      },
      async dispose() { calls.push('dispose'); return cleanup; },
    };
  };
  const services = { root, requireClientInspection: true, broker, settleMs: 30, pollMs: 5, sessionId: 'a'.repeat(32),
    acquire: async (b, dir) => { calls.push('acquire'); return { runtimeUrl, moduleVersion: version, pins: { 'index.html': { sha256: 'd'.repeat(64) } }, index: {} }; },
    acquireStyles: async () => { calls.push('styles'); return { pins: { 'style.css': { sha256: 'e'.repeat(64) } } }; },
    chromeExecutable: 'C:/chrome.exe',
    launchBrowser: async options => { calls.push('launch'); assert.ok(options.directory.startsWith(root)); return { dispose: async () => { calls.push('browser-dispose'); return { completed: true }; } }; },
    prepareUser: async (target, { sessionId }) => { calls.push('sign-in'); return { ok: true, descriptor: { binding: { lane: 'odc', runtimeUrl, module: 'Fixture', sessionId }, expiresAt: new Date(Date.now() + 60000).toISOString() } }; },
    releaseUser: async () => { calls.push('release'); return { ok: true }; },
    sameTarget: () => true };
  const readers = { binding, sourceContract: { sha256: 'A'.repeat(64) }, runtime: { moduleVersion: 'v1' },
    clientInspectionModels: async () => ['producer'], verifyPublication: async () => { calls.push('publication'); } };
  const lock = path.join(root, '.local', 'debugger', 'native-runs', createHash('sha256').update('odc|' + runtimeUrl + '|' + binding.moduleKey).digest('hex') + '.lock');
  return { root, calls, services, readers, lock, options: () => brokerOptions };
}
const input = { op: 'run', lane: 'odc', lifecycle: 'mounted', words: 'Mount PauseProbe in DEV for the debugger proof' };

test('mount needs client inspection, the user words and no screen inputs before any lock, asset or browser', async () => {
  for (const [request, services, expected] of [[{ ...input, words: '  ' }, {}, /explicit_authorization_required/],
    [input, { requireClientInspection: false }, /client_inspection_required/],
    [{ ...input, context: { screen: { inputs: { Id: 1 } } } }, {}, /screen_inputs_unsupported/]]) {
    const f = fixture();
    await assert.rejects(runOdcNativeMount(request, prepared(), f.readers, { ...f.services, ...services }), expected);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.lock), false);
  }
  const f = fixture(), p = prepared(); p.scenarios[0].inputs = { Id: { value: 1 } };
  await assert.rejects(runOdcNativeMount(input, p, f.readers, f.services), /screen_inputs_unsupported/);
});

test('authorized mount follows the original order and records the authorization before the browser exists', async () => {
  const f = fixture(), report = await runOdcNativeMount(input, prepared(), f.readers, f.services);
  assert.deepEqual(f.calls, ['acquire', 'styles', 'publication', 'launch', 'broker', 'prepare-browser', 'view-resources:' + screenKey,
    'sign-in', 'authenticate', 'publication', 'mount', 'ready', 'render', 'dispose', 'release']);
  assert.equal(report.ok, true); assert.equal(report.state, 'answered'); assert.equal(report.uncertain, false);
  assert.equal(report.mountPolicy, odcMountPolicy); assert.equal(report.staticEffectsQualified, false);
  assert.equal(report.applicationReady, true); assert.equal(report.lifecycleSettled, true); assert.equal(report.lifecycleComplete, false);
  // No declared handler is not evidence of a complete lifecycle.
  assert.ok(report.lifecycleIncompleteReasons.includes('handlers-undeclared'));
  assert.equal(report.appRequestIdentityProved, false); assert.equal(report.lockRetained, false); assert.equal(fs.existsSync(f.lock), false);
  const dir = path.dirname(report.receiptPath), authorization = fs.readFileSync(path.join(dir, 'authorization.json'));
  assert.equal(JSON.parse(authorization).words, input.words);
  assert.deepEqual(f.options().mountAuthorization, { policy: odcMountPolicy, runtimeUrl, screenKey,
    authorizationSha256: createHash('sha256').update(authorization).digest('hex') });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'mount-submission.json'))).metadata.policy, odcMountPolicy);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'mount-result.json'))).metadata.callbackReturned, true);
});

test('a lost mount reply is uncertain, keeps the lock and is never resubmitted', async () => {
  const f = fixture({ mount: 'lost' }), report = await runOdcNativeMount(input, prepared(), f.readers, f.services);
  assert.equal(report.state, 'uncertain'); assert.equal(report.ok, false); assert.equal(report.lockRetained, true);
  assert.equal(fs.existsSync(f.lock), true); assert.equal(f.calls.filter(c => c === 'mount').length, 1);
  assert.ok(f.calls.includes('dispose')); assert.ok(f.calls.includes('release'));
  await assert.rejects(runOdcNativeMount(input, prepared(), f.readers, f.services), /binding_busy/);
});

test('a confirmed native mount failure is a failure, not uncertainty', async () => {
  const f = fixture({ mount: 'native-failed' }), report = await runOdcNativeMount(input, prepared(), f.readers, f.services);
  assert.equal(report.state, 'failed'); assert.equal(report.uncertain, false); assert.equal(report.error, 'debug_odc_browser_mount_native_mount_failed');
  assert.equal(report.lockRetained, false); assert.equal(f.calls.includes('ready'), false);
});

test('unpinned view resources or a changed publication refuse before sign-in', async () => {
  const unpinned = fixture({ viewResources: false }), a = await runOdcNativeMount(input, prepared(), unpinned.readers, unpinned.services);
  assert.equal(a.state, 'failed'); assert.equal(unpinned.calls.includes('sign-in'), false); assert.equal(unpinned.calls.includes('mount'), false);
  assert.equal(a.lockRetained, false);
  const changed = fixture({ version: 'v2' }), b = await runOdcNativeMount(input, prepared(), changed.readers, changed.services);
  assert.equal(b.error, 'debug_odc_native_mount_publication_changed'); assert.equal(changed.calls.includes('launch'), false);
  assert.equal(b.lockRetained, false);
});

test('lifecycle settles only after native pauses resume and stay quiet', async () => {
  const f = fixture({ pauses: [{ paused: true, stops: 1 }, {}, {}, { paused: false }] });
  const report = await runOdcNativeMount(input, prepared(), f.readers, f.services);
  assert.equal(report.lifecycleSettled, true); assert.equal(report.inspection.stops, 1); assert.equal(report.inspection.paused, false);
});

const id = key => M + ':' + key;
test('handler coverage compares every declared screen and block handler with the native stop identities', async () => {
  // The live r3 shape: stops only in ScreenOnInitialize and ScreenOnReady.
  const functions = [...Array(6).fill(id(INIT)), ...Array(6).fill(id(READY))];
  const f = fixture({ functions }), report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'answered'); assert.equal(report.handlerCoverage.declared, 5);
  assert.deepEqual(report.handlerCoverage.observed, [
    { viewKey: screenKey, handler: 'onInitializeEventHandler', actionKey: INIT, stops: 6, firstIndex: 0, lastIndex: 5 },
    { viewKey: screenKey, handler: 'onReadyEventHandler', actionKey: READY, stops: 6, firstIndex: 6, lastIndex: 11 }]);
  assert.deepEqual(report.handlerCoverage.notObserved.map(h => [h.viewKey, h.handler]), [[screenKey, 'onDestroyEventHandler'],
    [blockKey, 'onInitializeEventHandler'], [blockKey, 'onParametersChangedEventHandler']]);
  assert.deepEqual(report.handlerCoverage.absent, [{ viewKey: screenKey, handler: 'onParametersChangedEventHandler' }]);
  assert.equal(report.lifecycleComplete, false); assert.equal(report.results[0].lifecycleComplete, false);
  assert.deepEqual(report.lifecycleIncompleteReasons, ['handlers-not-observed', 'navigation-unavailable']);
  assert.equal(report.renderVerified, true); assert.equal(report.results[0].renderVerified, true);
  assert.doesNotMatch(JSON.stringify(report.handlerCoverage), /value/);
});

test('every handler stopping is still not a complete lifecycle without OnDestroy after an authorized navigation', async () => {
  const functions = [INIT, READY, BLOCK_INIT, BLOCK_PARAMS, DESTROY].map(id);
  const f = fixture({ functions }), report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.deepEqual(report.handlerCoverage.notObserved, []);
  assert.equal(report.lifecycleComplete, false); assert.deepEqual(report.lifecycleIncompleteReasons, ['navigation-unavailable']);
});

test('uncertain cleanup keeps lifecycleComplete false', async () => {
  const functions = [INIT, READY, BLOCK_INIT, BLOCK_PARAMS, DESTROY].map(id);
  const f = fixture({ functions, cleanup: { completed: false } }), report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'uncertain'); assert.equal(report.lifecycleComplete, false);
  for (const reason of ['cleanup-incomplete', 'uncertain', 'run-not-answered']) assert.ok(report.lifecycleIncompleteReasons.includes(reason), reason);
});

test('renderVerified is recomputed from DOM and native evidence: mismatch, missing native read or a failed observation stay false', async () => {
  for (const render of [{ ...verifiedRender, bindings: [{ ...binding1, matches: false }] },
    { ...verifiedRender, bindings: [{ ...binding1, nativeRead: false, matches: false }] },
    { ...verifiedRender, roots: [{ key: screenKey, present: true }, { key: blockKey, present: false }] },
    { ...verifiedRender, bindings: [] }, { renderVerified: true }, new Error('debug_odc_browser_host_render_not_mounted')]) {
    const f = fixture({ render }), report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
    assert.equal(report.renderVerified, false); assert.equal(report.results[0].renderVerified, false);
    assert.ok(report.lifecycleIncompleteReasons.includes('render-unverified'));
    assert.equal(report.state, 'answered');
  }
  const failed = fixture({ render: new Error('debug_odc_browser_host_render_not_mounted') });
  assert.equal((await runOdcNativeMount(input, prepared(views), failed.readers, failed.services)).render.error, 'debug_odc_browser_host_render_not_mounted');
});

test('render is observed only after the lifecycle settles', async () => {
  const f = fixture({ pauses: [{ paused: true, stops: 1 }, ...Array(400).fill({ paused: true })] });
  f.services.prepareUser = async (target, { sessionId }) => ({ ok: true, descriptor: { binding: { lane: 'odc', runtimeUrl, module: 'Fixture', sessionId },
    expiresAt: new Date(Date.now() + 300).toISOString() } });
  const report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.lifecycleSettled, false); assert.equal(f.calls.includes('render'), false); assert.equal(report.renderVerified, false);
});

test('lifecycleComplete is computed true only when every piece of evidence is present', () => {
  const observed = [{ handler: 'onReadyEventHandler', stops: 1, lastIndex: 1 }, { handler: 'onDestroyEventHandler', stops: 1, lastIndex: 5 }];
  const base = { handlerCoverage: { declared: 2, observed, notObserved: [], absent: [] }, navigation: { authorized: true, completed: true, functionsBefore: 3 },
    renderVerified: true, lifecycleSettled: true, cleanup: { completed: true }, uncertain: false, state: 'answered', credentialsReleased: true, lockRetained: false };
  assert.deepEqual(odcLifecycleCompletion(base), { lifecycleComplete: true, lifecycleIncompleteReasons: [] });
  const early = { ...base, handlerCoverage: { ...base.handlerCoverage, observed: [observed[0], { ...observed[1], lastIndex: 2 }] } };
  assert.deepEqual(odcLifecycleCompletion(early).lifecycleIncompleteReasons, ['on-destroy-not-observed-after-navigation']);
  // OnDestroy exactly at the first navigation index counts; one before it does not, whatever else stopped later.
  assert.equal(odcLifecycleCompletion({ ...base, handlerCoverage: { ...base.handlerCoverage, observed: [observed[0], { ...observed[1], lastIndex: 3 }] } }).lifecycleComplete, true);
  for (const [patch, reason] of [[{ navigation: { authorized: false, completed: true, functionsBefore: 3 } }, 'navigation-unavailable'],
    [{ navigation: { authorized: true, completed: false, functionsBefore: 3 } }, 'navigation-unavailable'],
    [{ navigation: { authorized: true, completed: true } }, 'navigation-unavailable'], [{ navigation: undefined }, 'navigation-unavailable'],
    [{ handlerCoverage: { ...base.handlerCoverage, observed: [observed[0]], notObserved: [{ handler: 'onDestroyEventHandler', actionKey: 'x' }] } }, 'on-destroy-not-observed-after-navigation'],
    [{ renderVerified: false }, 'render-unverified'], [{ lifecycleSettled: false }, 'lifecycle-unsettled'],
    [{ cleanup: { completed: false } }, 'cleanup-incomplete'], [{ uncertain: true }, 'uncertain'], [{ state: 'failed' }, 'run-not-answered'],
    [{ credentialsReleased: false }, 'credentials-unreleased'], [{ lockRetained: true }, 'lock-retained'],
    [{ handlerCoverage: { declared: 0, observed: [], notObserved: [], absent: [] } }, 'handlers-undeclared'],
    [{ handlerCoverage: { ...base.handlerCoverage, notObserved: [{ handler: 'onRenderEventHandler' }] } }, 'handlers-not-observed']]) {
    const result = odcLifecycleCompletion({ ...base, ...patch });
    assert.equal(result.lifecycleComplete, false); assert.ok(result.lifecycleIncompleteReasons.includes(reason), reason);
  }
});

// Navigation scenarios: prepared by prepareOdcMountNavigation (wired in prepareNativeEntry).
const TARGET = 'T4rgetPs1DwUyB5poRbGhw', T_INIT = 'X1JJnWDBJUGdVNVnSt55DQ', T_DESTROY = 'X2JJnWDBJUGdVNVnSt55DQ';
const qsha = q => createHash('sha256').update(q).digest('hex');
const navigated = () => {
  const p = prepared(views);
  p.mount.route = { screenName: 'MainFlow.PauseProbe', default: true };
  p.mount.navigation = { screenKey: TARGET, segment: 'InputProbe', back: true, requiredModelRoots: [T_INIT, T_DESTROY],
    views: [{ key: TARGET, handlers: [{ handler: 'onInitializeEventHandler', actionKey: T_INIT }, { handler: 'onDestroyEventHandler', actionKey: T_DESTROY }], absentHandlers: [] }] };
  p.scenarios = [['one', 'Seed=1'], ['two', 'Seed=2']].map(([name, query]) => ({ name, inputs: {}, context: { screen: { inputs: { Seed: query.slice(5) } } },
    navigation: { inputs: [['Seed', query.slice(5)]], query, querySha256: qsha(query) } }));
  return p;
};
test('navigation targets and every scenario inputs sha256 are in authorization.json before the browser exists', async () => {
  const f = fixture(); let authorizationAtLaunch;
  const launch = f.services.launchBrowser;
  f.services.launchBrowser = async options => {
    const dir = path.dirname(path.dirname(options.directory + '/x'));
    authorizationAtLaunch = JSON.parse(fs.readFileSync(path.join(dir, 'authorization.json'))); return launch(options);
  };
  const report = await runOdcNativeMount(input, navigated(), f.readers, f.services);
  assert.equal(report.state, 'answered', report.error);
  assert.deepEqual(authorizationAtLaunch.route, { default: true });
  assert.deepEqual(authorizationAtLaunch.navigation, { screenKey: TARGET, segment: 'InputProbe', back: true,
    scenarios: [{ name: 'one', inputsSha256: qsha('Seed=1') }, { name: 'two', inputsSha256: qsha('Seed=2') }] });
  assert.deepEqual(f.options().mountAuthorization.navigation, { screenKey: TARGET, segment: 'InputProbe', back: true, inputsSha256: [qsha('Seed=1'), qsha('Seed=2')] });
});
test('one navigation per scenario, each settling before and after navigateBack, journaled per scenario', async () => {
  const f = fixture(), report = await runOdcNativeMount(input, navigated(), f.readers, f.services);
  const nav = f.calls.filter(c => c.startsWith('navigate:'));
  assert.deepEqual(nav, ['navigate:forward:{"Seed":"1"}', 'navigate:back', 'navigate:forward:{"Seed":"2"}', 'navigate:back']);
  assert.ok(f.calls.indexOf('render') < f.calls.indexOf(nav[0]));
  assert.equal(report.navigation.authorized, true); assert.equal(report.navigation.completed, true);
  assert.equal(report.navigation.functionsBefore, 0);
  const dir = path.dirname(report.receiptPath);
  for (const name of ['one', 'two']) for (const file of ['navigation-submission', 'navigation-result', 'back-submission', 'back-result'])
    assert.ok(fs.existsSync(path.join(dir, 'scenarios', name, file + '.json')), name + '/' + file);
  const scenarios = report.results.filter(r => r.navigation);
  assert.deepEqual(scenarios.map(r => [r.name, r.navigation.reached, r.navigation.settled, r.back.reached, r.back.settled]),
    [['one', true, true, true, true], ['two', true, true, true, true]]);
  assert.equal(report.ok, true); assert.equal(report.lockRetained, false);
});
test('OnDestroy after the first authorized navigation counts toward lifecycle completion; target handlers are covered', async () => {
  const functions = [INIT, READY, BLOCK_INIT, BLOCK_PARAMS].map(id);
  const f = fixture({ functions, navigationFunctions: { forward: [id(DESTROY), id(T_INIT)], back: [id(T_DESTROY)] } });
  const report = await runOdcNativeMount(input, navigated(), f.readers, f.services);
  assert.deepEqual(report.handlerCoverage.notObserved, []); assert.equal(report.handlerCoverage.declared, 7);
  assert.equal(report.navigation.functionsBefore, 4);
  assert.deepEqual(report.lifecycleIncompleteReasons, []); assert.equal(report.lifecycleComplete, true);
});
test('OnDestroy stopped only before the first navigation, or a navigation that did not complete, never completes the lifecycle', async () => {
  // OnDestroy of the mounted screen stopped during the initial lifecycle (index 4 < functionsBefore 5).
  const early = fixture({ functions: [INIT, READY, BLOCK_INIT, BLOCK_PARAMS, DESTROY].map(id), navigationFunctions: { forward: [id(T_INIT)], back: [id(T_DESTROY)] } });
  const a = await runOdcNativeMount(input, navigated(), early.readers, early.services);
  assert.equal(a.state, 'answered'); assert.equal(a.navigation.completed, true); assert.equal(a.navigation.functionsBefore, 5);
  assert.deepEqual(a.handlerCoverage.notObserved, []);
  assert.deepEqual(a.lifecycleIncompleteReasons, ['on-destroy-not-observed-after-navigation']); assert.equal(a.lifecycleComplete, false);
  // OnDestroy stops after the submission, but the navigation was not confirmed: completed stays false.
  const unreached = fixture({ functions: [INIT, READY, BLOCK_INIT, BLOCK_PARAMS].map(id), navigation: 'unreached',
    navigationFunctions: { forward: [id(DESTROY), id(T_INIT)], back: [id(T_DESTROY)] } });
  const b = await runOdcNativeMount(input, navigated(), unreached.readers, unreached.services);
  assert.equal(b.state, 'answered'); assert.equal(b.navigation.completed, false); assert.equal(b.ok, false);
  assert.deepEqual(unreached.calls.filter(c => c.startsWith('navigate:')), ['navigate:forward:{"Seed":"1"}', 'navigate:back']);
  assert.ok(b.lifecycleIncompleteReasons.includes('navigation-unavailable')); assert.equal(b.lifecycleComplete, false);
});
test('a lost navigation reply makes the run uncertain, keeps the lock and is never resent', async () => {
  const f = fixture({ navigation: 'lost' }), report = await runOdcNativeMount(input, navigated(), f.readers, f.services);
  assert.equal(report.state, 'uncertain'); assert.equal(report.lockRetained, true); assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.calls.filter(c => c.startsWith('navigate:')), ['navigate:forward:{"Seed":"1"}']);
  assert.ok(f.calls.includes('dispose')); assert.ok(f.calls.includes('release'));
});
test('screen_inputs_unsupported is lifted only for navigation and deep-link scenarios', async () => {
  for (const mutate of [p => { p.scenarios[0].inputs = { Id: { value: 1 } }; }, p => { p.scenarios[0].navigation.querySha256 = 'f'.repeat(64); },
    p => { p.scenarios[0].context = { screen: { inputs: { Seed: '1' }, variables: { X: 1 } } }; }, p => { delete p.scenarios[1].navigation; },
    p => { p.mount.navigation.back = false; }]) {
    const f = fixture(), p = navigated(); mutate(p);
    await assert.rejects(runOdcNativeMount(input, p, f.readers, f.services), /screen_inputs_unsupported/);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.lock), false);
  }
  const plain = fixture(), p = prepared(); p.scenarios.push({ name: 'scenario-2', inputs: {} });
  await assert.rejects(runOdcNativeMount(input, p, plain.readers, plain.services), /screen_inputs_unsupported/);
});
test('deep link: the named route segment and query sha256 are authorized before the browser and passed to the host', async () => {
  const f = fixture(), p = prepared(views);
  p.mount.route = { screenName: 'MainFlow.InputProbe', default: false, segment: 'InputProbe', query: 'Seed=9', querySha256: qsha('Seed=9') };
  p.scenarios[0].context = { screen: { inputs: { Seed: '9' } } };
  const report = await runOdcNativeMount(input, p, f.readers, f.services);
  assert.equal(report.state, 'answered', report.error);
  const authorization = JSON.parse(fs.readFileSync(path.join(path.dirname(report.receiptPath), 'authorization.json')));
  assert.deepEqual(authorization.route, { default: false, segment: 'InputProbe', querySha256: qsha('Seed=9') });
  assert.deepEqual(f.options().mountAuthorization.route, { segment: 'InputProbe', query: 'Seed=9', querySha256: qsha('Seed=9') });
  assert.equal(f.calls.some(c => c.startsWith('navigate:')), false);
  for (const mutate of [q => { q.mount.route.querySha256 = 'f'.repeat(64); }, q => { q.scenarios.push({ name: 'b', inputs: {} }); }]) {
    const g = fixture(), q = structuredClone(p); mutate(q);
    await assert.rejects(runOdcNativeMount(input, q, g.readers, g.services), /screen_inputs_unsupported/);
  }
});

// run.interactions: resolved by prepareOdcMountInteractions (wired in prepareNativeEntry).
const SAVE = 'SvAheqsdZEGBVNun+Anl5w';
const clicked = () => { const p = prepared(views); p.mount.interactions = [{ target: '@Wd9JnWDBJUGdVNVnSt55DQ', event: 'click', name: 'SaveButton', viewKey: screenKey, actionKey: SAVE }]; return p; };
test('interactions are recorded in authorization.json before the browser and clicked once after the lifecycle settles, journaled once', async () => {
  const f = fixture({ interactionFunctions: [id(SAVE)] }); let authorizationAtLaunch;
  const launch = f.services.launchBrowser;
  f.services.launchBrowser = async options => { authorizationAtLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(options.directory), 'authorization.json'))); return launch(options); };
  const report = await runOdcNativeMount(input, clicked(), f.readers, f.services);
  assert.equal(report.state, 'answered', report.error); assert.equal(report.ok, true); assert.equal(report.lockRetained, false);
  assert.deepEqual(authorizationAtLaunch.interactions, clicked().mount.interactions);
  assert.deepEqual(f.options().interactionAuthorization, clicked().mount.interactions);
  assert.equal(Object.hasOwn(f.options().mountAuthorization, 'interactions'), false);
  // After the settled lifecycle and render, never while paused; one click.
  assert.deepEqual(f.calls.filter(c => c.startsWith('interact:')), ['interact:0']);
  assert.ok(f.calls.indexOf('render') < f.calls.indexOf('interact:0'));
  const dir = path.join(path.dirname(report.receiptPath), 'interactions', '1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'interaction-submission.json'))).metadata.sequence, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'interaction-result.json'))).metadata.dispatched, true);
  assert.deepEqual(report.interactions, [{ index: 0, target: '@Wd9JnWDBJUGdVNVnSt55DQ', name: 'SaveButton', actionKey: SAVE, dispatched: true, trusted: true,
    settled: true, functionsBefore: 0, handlerObserved: true }]);
  assert.deepEqual(report.results.map(r => [r.name, r.ok]), [['scenario-1', true], ['interaction-1', true]]);
});
test('a lost interaction reply is uncertain, keeps the lock and is never resent; a refused click is a known failure', async () => {
  const f = fixture({ interaction: 'lost' }), report = await runOdcNativeMount(input, clicked(), f.readers, f.services);
  assert.equal(report.state, 'uncertain'); assert.equal(report.lockRetained, true); assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.calls.filter(c => c.startsWith('interact:')), ['interact:0']);
  assert.ok(f.calls.includes('dispose')); assert.ok(f.calls.includes('release'));
  const g = fixture({ interaction: 'hidden' }), refused = await runOdcNativeMount(input, clicked(), g.readers, g.services);
  assert.equal(refused.state, 'failed'); assert.equal(refused.error, 'debug_native_browser_interaction_element_hidden');
  assert.equal(refused.uncertain, false); assert.equal(refused.lockRetained, false);
});
test('invalid interactions refuse before any lock, asset or browser', async () => {
  for (const mutate of [p => { p.mount.interactions = []; }, p => { p.mount.interactions[0].event = 'dblclick'; }, p => { p.mount.interactions[0].actionKey = 'x'; },
    p => { p.mount.interactions = Array(11).fill(p.mount.interactions[0]); }]) {
    const f = fixture(), p = clicked(); mutate(p);
    await assert.rejects(runOdcNativeMount(input, p, f.readers, f.services), /interactions_invalid/);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.lock), false);
  }
});
const exceptionStop = { paused: true, stops: 1, functions: [id(INIT)], exceptions: [{ stop: 1, function: id(INIT), type: 'Error' }] };
test('a handled lifecycle exception through the SDK error page is a known failure with exception-stop evidence; the lock is released after cleanup', async () => {
  const errorPage = { observed: true, navigated: true, marked: true, historyNavigated: true, valuesRead: false, appCodeCalled: false };
  for (const options of [{ errorPage }, { errorPage: { observed: false, valuesRead: false }, ready: { nativeApplicationReady: false, nativePromiseCompleted: false, errorPageObserved: true,
    errorPage: { navigated: true, marked: true, valuesRead: false }, lifecycleComplete: false } }]) {
    const f = fixture({ ...options, pauses: [exceptionStop, {}, {}, { paused: false }] });
    const report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
    assert.equal(report.state, 'failed'); assert.equal(report.error, 'debug_odc_native_mount_lifecycle_exception');
    assert.equal(report.uncertain, false); assert.equal(report.lockRetained, false); assert.equal(fs.existsSync(f.lock), false);
    assert.deepEqual(report.lifecycleException, { phase: 'lifecycle', knownNativeFailure: true, exceptionStops: 1,
      exceptions: [{ function: id(INIT), type: 'Error' }], errorPage: { navigated: true, marked: true } });
    assert.equal(f.calls.includes('render'), false); assert.ok(f.calls.indexOf('dispose') < f.calls.indexOf('release'));
    assert.equal(report.cleanup.completed, true); assert.equal(report.credentialsReleased, true); assert.equal(report.lifecycleComplete, false);
  }
});
test('an exception stop without the error path is reported, not a failure; a lost reply with an exception stays uncertain', async () => {
  const f = fixture({ pauses: [exceptionStop, {}, {}, { paused: false }], errorPage: { observed: true, navigated: false, marked: false, historyNavigated: false } });
  const report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'answered'); assert.equal(report.lifecycleException, undefined);
  assert.deepEqual(report.exceptionStops, [{ function: id(INIT), type: 'Error' }]);
  assert.deepEqual(report.errorPage, { navigated: false, marked: false, observed: true, valuesRead: false });
  const lost = fixture({ mount: 'lost', pauses: [exceptionStop] });
  const uncertain = await runOdcNativeMount(input, prepared(views), lost.readers, lost.services);
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.lockRetained, true);
});
test('a failed ready wait still reads the original error path: with an exception stop it is the known lifecycle failure', async () => {
  const errorPage = { observed: true, navigated: false, marked: false, historyNavigated: true, valuesRead: false, appCodeCalled: false };
  const f = fixture({ ready: new Error('debug_odc_native_worker_reply_failed'), errorPage, pauses: [exceptionStop] });
  const report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'failed'); assert.equal(report.error, 'debug_odc_native_mount_lifecycle_exception');
  assert.deepEqual(report.lifecycleException, { phase: 'ready', knownNativeFailure: true, exceptionStops: 1,
    exceptions: [{ function: id(INIT), type: 'Error' }], errorPage: { navigated: true, marked: false } });
  assert.equal(report.uncertain, false); assert.equal(report.lockRetained, false); assert.ok(f.calls.indexOf('error-page') < f.calls.indexOf('dispose'));
  // Without an exception stop, or without error-page evidence, the original ready error stands.
  for (const options of [{ errorPage }, { errorPage: { observed: true, navigated: false, marked: false, historyNavigated: false }, pauses: [exceptionStop] }]) {
    const g = fixture({ ready: new Error('debug_odc_browser_ready_unconfirmed'), ...options });
    const failed = await runOdcNativeMount(input, prepared(views), g.readers, g.services);
    assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'debug_odc_browser_ready_unconfirmed');
    assert.equal(failed.lifecycleException, undefined); assert.equal(failed.lockRetained, false);
  }
});
test('the SDK error page without an exception stop (no pauseOnExceptions) fails as error_page_observed, not uncertain', async () => {
  const f = fixture({ ready: { nativeApplicationReady: false, nativePromiseCompleted: false, errorPageObserved: true,
    errorPage: { navigated: true, marked: true, valuesRead: false }, lifecycleComplete: false } });
  const report = await runOdcNativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'failed'); assert.equal(report.error, 'debug_odc_native_mount_error_page_observed');
  assert.deepEqual(report.lifecycleException, { phase: 'lifecycle', knownNativeFailure: true, exceptionStops: 0, exceptions: [], errorPage: { navigated: true, marked: true } });
  assert.equal(report.uncertain, false); assert.equal(report.lockRetained, false); assert.equal(report.exceptionStops, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createO11NativeBrowserHost, createO11BrowserRuntime, createO11NativeMountBroker } from '../debug-o11-native-browser-host.mjs';
import { createO11BrowserMount, waitForO11BrowserReady, o11MountPolicy, isO11MountRequest } from '../debug-o11-browser-mount.mjs';
import { writeO11MountFixture, o11FixtureUrl, o11FixtureModule as M } from './fixtures/debug-o11-mount-fixture.mjs';

const screenKey = 'W4JQW+OX20iILeFJFpMkqA', moduleKey = 'Mif02PxcH0K7KiABEHTwMg', handleRe = /^__ssamO11Runtime_[a-f0-9]{48}$/;
const login = { modelFactory: M + '.Common.Login.mvc$model', controllerFactory: M + '.Common.Login.mvc$controller', method: 'doLogin$ServerAction',
  viewName: 'Common.Login', apiVersion: 'abcdefghijklmnopqrstuv', endpoint: '/' + M + '/screenservices/' + M + '/Common/Login/ServiceAPIDoLogin' };
const mountAuthorization = { policy: o11MountPolicy, authorizationSha256: 'b'.repeat(64), runtimeUrl: o11FixtureUrl, screenKey };

// The fake page models documents: Page.navigate replies before the new document commits
// (lags[n] probes later), and the old document keeps its URL and marks until then.
function fixture({ installFails = false, lags = [], destroyedProbes = 0, neverCommit = false } = {}) {
  const calls = [], expressions = [], realms = [], runtime = writeO11MountFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-host-')));
  let authConfirmed = false, started = false, doc = { href: 'about:blank', generation: 0, marks: {} }, pending, navigations = 0;
  const host = { inspectionUrl: 'ws://127.0.0.1:9/devtools/page/x', receipt: () => ({ scope: 'owned-browser-process' }),
    dispose: async () => { calls.push('owned-exit'); return { completed: true, ownedProcessExited: true }; },
    page: { async send(method, params) { calls.push(method);
      if (method === 'Page.navigate') { assert.equal(params.url, o11FixtureUrl); pending = { lag: neverCommit ? Infinity : lags[navigations] ?? 0 }; navigations++;
        return { frameId: 'F', loaderId: 'L' + navigations }; }
      if (method === 'Runtime.evaluate') {
      assert.match(params.expression, /createO11BrowserRuntime|debug_o11_browser_runtime_/);
      const realm = /"realm":"(\w+)"/.exec(params.expression)?.[1];
      calls.push('realm:' + realm); expressions.push(params.expression); realms.push({ realm, generation: doc.generation, pending: !!pending });
      return { result: { value: { initialized: !installFails } } }; } return {}; },
    async evaluate(fn, arg) { const source = fn.toString();
      if (source.includes('readyState')) {
        if (pending && destroyedProbes > 0) { destroyedProbes--; throw new Error('Execution context was destroyed'); }
        if (pending && pending.lag > 0) pending.lag--;
        else if (pending) { doc = { href: o11FixtureUrl, generation: doc.generation + 1, marks: {} }; pending = undefined; }
        return { href: doc.href, stale: doc.marks[arg] === true, state: 'complete' }; }
      // A bare URL probe sees the old document, which already shows plan.url during the reload.
      if (source.includes('location.href')) return doc.href;
      if (source.includes('=true')) { doc.marks[arg] = true; return true; }
      if (source.includes('discard')) { calls.push('discard'); return { discarded: true }; }
      if (source.includes('.dispose()')) { calls.push('native-clear'); return { authenticationCleared: true }; }
      return undefined; } } };
  const services = {
    installAssets: async () => { calls.push('assets'); return { receipt: () => ({}), dispose: async () => { calls.push('assets-close'); return { completed: true }; } }; },
    session: () => ({ request: async () => undefined, receipt: () => ({ signIn: {}, requests: {}, credentialsHeld: false }),
      clear: async () => { calls.push('session-clear'); return { cleared: true }; } }),
    authentication: ({ reload }) => ({ receipt: () => ({ confirmed: authConfirmed }),
      authenticate: async () => { calls.push('login'); await reload(); authConfirmed = true; return { authenticated: true, identityMatches: true }; } }),
    installInspection: async ({ runtimeHandle, options }) => { calls.push('install-inspector:' + options.platform); assert.match(runtimeHandle, handleRe);
      return { capability: { url: host.inspectionUrl, helperName: '__ssamInspection_' + 'f'.repeat(48), privateCapture: true },
        start: async () => { started = true; calls.push('start-inspector'); return { started: true }; },
        receipt: () => ({ started, closed: false }), remove: async () => { calls.push('remove-inspector'); return { removed: true }; } }; },
    mount: options => { assert.equal(options.authorization.staticEffectsQualified, false); calls.push('mount-coordinator');
      return { mount: async () => { calls.push('bootstrap'); return { startupCallbackReturned: true, lifecycleComplete: false }; }, receipt: () => ({ callbackReturned: true }) }; },
    waitForReady: async () => { calls.push('ready'); return { nativeApplicationReady: true, nativePromiseCompleted: true, routerRendered: true }; } };
  const args = { host, runtime, binding: { runtimeUrl: o11FixtureUrl, module: M, moduleKey, sessionId: 'a'.repeat(32) }, login, mountAuthorization,
    beforeSignIn: async () => ({ recorded: true }), recordSignInResult: async () => ({ recorded: true }),
    beforeMount: async () => ({ recorded: true }), recordMountOutcome: async () => ({ recorded: true }) };
  return { calls, expressions, realms, host, services, args };
}

test('the original bootstrap, which requires the screen controllers, runs only after the inspection started in the clean mount realm', async () => {
  const f = fixture(), adapter = await createO11NativeBrowserHost(f.args, f.services);
  assert.deepEqual(f.calls.filter(c => /^realm:|assets$|Page\.navigate/.test(c)), ['assets', 'Page.navigate', 'realm:preparation']);
  await assert.rejects(adapter.configureInspection({}), /inspection_not_ready/);
  await assert.rejects(adapter.mount(), /mount_not_ready/);
  await adapter.authenticate({});
  // The login realm is discarded and a fresh realm loads the classic scripts without the bootstrap.
  assert.deepEqual(f.calls.filter(c => ['login', 'discard', 'Page.navigate', 'realm:preparation', 'realm:mount'].includes(c)),
    ['Page.navigate', 'realm:preparation', 'login', 'discard', 'Page.navigate', 'realm:mount']);
  // Only the discarded preparation realm receives the pinned moduleinfo.
  assert.match(f.expressions[0], /"appInfo":/); assert.doesNotMatch(f.expressions[1], /"appInfo":/);
  assert.equal((await adapter.configureInspection({ modules: [], variables: [] })).privateCapture, true);
  assert.ok(f.calls.includes('install-inspector:o11'));
  assert.equal(f.calls.includes('bootstrap'), false);
  const mounted = await adapter.mount();
  assert.equal(mounted.lifecycleComplete, false);
  assert.ok(f.calls.indexOf('start-inspector') < f.calls.indexOf('mount-coordinator'));
  assert.ok(f.calls.indexOf('start-inspector') < f.calls.indexOf('bootstrap'));
  await assert.rejects(adapter.mount(), /mount_not_ready/);
  assert.equal((await adapter.waitForApplicationReady()).nativeApplicationReady, true);
  assert.equal(f.calls.filter(c => c === 'bootstrap').length, 1);
  await adapter.dispose();
});

test('a realm is installed only in a newly committed document, even when the old one still shows the same URL', async () => {
  // Page.navigate replies before the commit; the preparation document already has plan.url during the reload.
  const f = fixture({ lags: [2, 4], destroyedProbes: 1 }), adapter = await createO11NativeBrowserHost(f.args, f.services);
  await adapter.authenticate({});
  assert.deepEqual(f.realms.map(r => [r.realm, r.generation, r.pending]), [['preparation', 1, false], ['mount', 2, false]]);
  await adapter.dispose();
  // A navigation that never commits ends the preparation; a reload that never commits ends the sign-in.
  const stuck = fixture({ neverCommit: true });
  await assert.rejects(createO11NativeBrowserHost(stuck.args, { ...stuck.services, navigationTimeoutMs: 150 }), /prepare_navigation_failed/);
  assert.deepEqual(stuck.realms, []); assert.ok(stuck.calls.includes('owned-exit'));
  const late = fixture({ lags: [0, Infinity] }), b = await createO11NativeBrowserHost(late.args, { ...late.services, navigationTimeoutMs: 150 });
  await assert.rejects(b.authenticate({}), /navigation_unconfirmed/);
  assert.deepEqual(late.realms.map(r => r.realm), ['preparation']);
  await b.dispose();
  // A refused navigation is never taken as committed.
  const refused = fixture(); const send = refused.host.page.send;
  refused.host.page.send = async (method, params) => method === 'Page.navigate' ? (refused.calls.push(method), { errorText: 'net::ERR_BLOCKED_BY_CLIENT' }) : send(method, params);
  await assert.rejects(createO11NativeBrowserHost(refused.args, refused.services), /prepare_navigation_failed/);
  assert.equal(refused.calls.some(c => c.startsWith('realm:')), false);
});

test('dispose confirms inspector removal, native and host authentication clear, owned process exit and the asset boundary', async () => {
  const f = fixture(), adapter = await createO11NativeBrowserHost(f.args, f.services);
  await adapter.authenticate({}); await adapter.configureInspection({}); await adapter.mount();
  const result = await adapter.dispose();
  assert.equal(result.completed, true);
  assert.deepEqual(f.calls.slice(f.calls.indexOf('remove-inspector')), ['remove-inspector', 'native-clear', 'session-clear', 'owned-exit', 'assets-close']);
  assert.equal(result.inspector.removed, true); assert.equal(result.native.authenticationCleared, true);
  assert.equal(result.session.cleared, true); assert.equal(result.owned.ownedProcessExited, true);
  const again = f.calls.length; await adapter.dispose(); assert.equal(f.calls.length, again);
  await assert.rejects(adapter.authenticate({}), /disposed/);
  for (const broken of [s => { s.installInspection = async () => ({ capability: {}, start: async () => {}, receipt: () => ({ started: true, closed: false }),
    remove: async () => ({ removed: false }) }); }, s => { s.session = () => ({ request: async () => undefined, receipt: () => ({}), clear: async () => ({ cleared: false }) }); },
    (s, f) => { f.host.dispose = async () => ({ completed: false }); }]) {
    const g = fixture(); broken(g.services, g);
    const a = await createO11NativeBrowserHost(g.args, g.services); await a.authenticate({}); await a.configureInspection({});
    assert.equal((await a.dispose()).completed, false);
  }
});

test('the mount authorization is fixed before assets load; unowned browsers and static flags are refused', async () => {
  const f = fixture();
  for (const bad of [{ ...mountAuthorization, staticEffectsQualified: true }, { ...mountAuthorization, runtimeUrl: 'https://other.example.com/' + M + '/' },
    { ...mountAuthorization, route: { segment: 'X' } }])
    await assert.rejects(createO11NativeBrowserHost({ ...f.args, mountAuthorization: bad }, f.services), /mount_authorization_invalid/);
  for (const bad of [{ ...login, endpoint: '/Other_UI/screenservices/Other_UI/X' }, { ...login, method: 'constructor' }, { ...login, apiVersion: 'short' }])
    await assert.rejects(createO11NativeBrowserHost({ ...f.args, login: bad }, f.services), /login_contract_invalid/);
  const unowned = fixture(); unowned.host.receipt = () => ({ scope: 'user-browser' });
  await assert.rejects(createO11NativeBrowserHost(unowned.args, unowned.services), /contract_invalid/);
  assert.deepEqual(f.calls, []); assert.deepEqual(unowned.calls, []);
  assert.equal(isO11MountRequest(mountAuthorization), true);
  // Without authorization the host never starts the inspector for a mount nor runs the bootstrap.
  const plain = fixture(), adapter = await createO11NativeBrowserHost({ ...plain.args, mountAuthorization: undefined }, plain.services);
  await adapter.authenticate({}); await adapter.configureInspection({});
  await assert.rejects(adapter.mount(), /mount_not_authorized/);
  assert.equal(plain.calls.includes('start-inspector'), false); assert.equal(plain.calls.includes('bootstrap'), false);
  await adapter.dispose();
  const failing = fixture({ installFails: true });
  await assert.rejects(createO11NativeBrowserHost(failing.args, failing.services), /prepare_runtime_failed/);
  assert.ok(failing.calls.includes('owned-exit')); assert.ok(failing.calls.includes('assets-close'));
});

// ---- in-page runtime, run in a minimal fake document --------------------------------------------------------
function page(runtimeSteps) {
  const loaded = [], listeners = {}, storage = { cleared: 0 };
  const head = { appendChild(script) { loaded.push(script.src); queueMicrotask(() => { const run = runtimeSteps[script.src.split('?')[0].split('/').pop()];
    try { run?.(sandbox, script); } catch { listeners.error?.({ filename: script.src }); } script.onload?.(); }); } };
  const container = { childElementCount: 0 };
  const sandbox = { location: { href: o11FixtureUrl }, console, URL, Promise, setTimeout, clearTimeout, queueMicrotask,
    document: { head, createElement: () => ({}), getElementById: id => id === 'reactContainer' ? container : null, cookie: '' },
    localStorage: { clear: () => storage.cleared++ }, sessionStorage: { clear: () => storage.cleared++ },
    addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: (name) => { delete listeners[name]; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  return { sandbox, loaded, storage, container, context: vm.createContext(sandbox) };
}
const plain = value => JSON.parse(JSON.stringify(value));
const amdRuntime = (sandbox, { ready = true } = {}) => {
  const app = { isReady: false, waitForAppReady: async () => { if (!ready) await new Promise(() => {}); app.isReady = true; } };
  const modules = { 'OutSystems/ClientRuntime/Main': { Internal: { DataTypes: { BinaryData: class BinaryData {} }, Application: { default: app } } },
    'OutSystems/ClientRuntime/Debugger': { DebuggerDataConverter: { to: v => v } } };
  sandbox.require = (names, ok) => queueMicrotask(() => ok(...names.map(n => modules[n])));
  sandbox.require.defined = name => name in modules;
  sandbox.OutSystemsDebugger = { isInSession: false };
};

test('the in-page runtime loads the original classic order, defers the bootstrap and mounts it exactly once', async () => {
  const runtime = writeO11MountFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-rt-')));
  const { planO11BrowserAssets } = await import('../debug-o11-browser-assets.mjs');
  const plan = planO11BrowserAssets(runtime);
  let bootstrapRuns = 0;
  const p = page({ 'OutSystemsManifestLoader.js': s => { s.OSManifestLoader = { indexVersionToken: null }; }, 'OutSystems.js': s => amdRuntime(s),
    [M + '.index.js']: s => { bootstrapRuns++; p.container.childElementCount = 1; } });
  const contract = { url: plan.url, realm: 'mount', steps: plan.steps, bootstrap: { src: plan.bootstrap.src } };
  const rt = await vm.runInContext('(' + createO11BrowserRuntime.toString() + ')(' + JSON.stringify(contract) + ')', p.context);
  assert.deepEqual(p.loaded.map(u => u.split('?')[0].split('/').pop()), ['OutSystemsManifestLoader.js', 'OutSystems.js', 'OutSystemsSettings.js', 'Debugger.js', M + '.appDefinition.js']);
  assert.equal(p.sandbox.OutSystemsApp.basePath, '/' + M + '/'); assert.equal(p.sandbox.OSManifestLoader.indexVersionToken, 'lMo2PVvJ4vvkAwjP5zW2Nw');
  assert.equal(typeof rt.nativeBinaryType(), 'function'); assert.equal(typeof rt.nativeConverter().to, 'function');
  assert.equal(bootstrapRuns, 0);
  await assert.rejects(rt.authenticate({}, login), /realm_invalid/);
  assert.deepEqual(plain(await rt.boot.__ssamMount()), { invoked: true, callbackReturned: true });
  assert.deepEqual(plain(await rt.boot.__ssamMount()), { invoked: false, callbackReturned: false });
  assert.equal(bootstrapRuns, 1); assert.equal(p.loaded.at(-1), plan.bootstrap.src);
  assert.equal(rt.application().isReady, false);
  assert.deepEqual(plain(await rt.dispose()), { authenticationCleared: true }); assert.equal(p.storage.cleared, 2);
  // A preparation realm never mounts.
  const q = page({ 'OutSystemsManifestLoader.js': s => { s.OSManifestLoader = {}; }, 'OutSystems.js': s => amdRuntime(s) });
  const prep = await vm.runInContext('(' + createO11BrowserRuntime.toString() + ')(' + JSON.stringify({ ...contract, realm: 'preparation' }) + ')', q.context);
  assert.deepEqual(plain(await prep.boot.__ssamMount()), { invoked: false, callbackReturned: false });
  assert.equal(q.loaded.includes(plan.bootstrap.src), false);
});

test('the preparation realm signs in with Minimal initialization and the pinned manifest only; it never mounts', async () => {
  const runtime = writeO11MountFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-prep-')));
  const { planO11BrowserAssets } = await import('../debug-o11-browser-assets.mjs');
  const plan = planO11BrowserAssets(runtime), order = [], required = [];
  const p = page({ 'OutSystemsManifestLoader.js': s => { s.OSManifestLoader = {}; }, 'OutSystems.js': s => {
    class BaseViewController { dispose() { order.push('controller-dispose'); } callContext() { return { withTimeout: t => ({ timeout: t }) }; } }
    class LoginController extends BaseViewController { async ['doLogin$ServerAction'](u, pw, remember, ctx) { order.push(['login', u, pw, remember, ctx.timeout]); } }
    const modules = {
      'OutSystems/ClientRuntime/Main': { Internal: { DataTypes: { BinaryData: class {} }, Interfaces: { Application: { InitializationType: { Full: 0, Minimal: 1 } } },
        Application: { default: { initialize: async (definition, type) => { order.push(['initialize', definition.homeModuleName, type]); return true; } } },
        WidgetNaming: { WidgetIdService: class {} }, Controller: { BaseViewController }, BuiltinFunctions: { nullIdentifier: () => 0 } } },
      'OutSystems/ClientRuntime/Debugger': { DebuggerDataConverter: { to: v => v } },
      [M + '.appDefinition']: { homeModuleName: M },
      'OutSystems/ClientRuntime/RolesInfo': { storeRoleInformation: async r => order.push(['roles', r]), checkRegistered: () => order.push('registered'), getUserId: () => 7 },
      'OutSystems/ClientRuntime/Communication': { getRoles: async () => 'roles-text' },
      'OutSystems/ClientRuntime/ApplicationInfo': { setModules: m => order.push(['modules', typeof m]) },
      'OutSystems/ClientRuntime/VersionsManager': { default: {}, buildScriptMap: (urls, token, cdn) => { order.push(['script-map', token, cdn]); return { mapped: true }; } },
      'OutSystems/ClientRuntime/RequireManager': { configure: map => order.push(['require-configure', map.mapped]) },
      'OutSystems/ClientRuntime/Settings': { getEnvParams: () => ({ CDNFilenameVersioning: false }) },
      [login.modelFactory]: { create: options => ({ options }) },
      [login.controllerFactory]: { create: () => new LoginController() } };
    s.require = (names, ok) => { required.push(...names); queueMicrotask(() => ok(...names.map(n => modules[n]))); };
    s.OutSystemsDebugger = { isInSession: false };
    s.__versions = modules['OutSystems/ClientRuntime/VersionsManager']; } });
  const contract = { url: plan.url, realm: 'preparation', steps: plan.steps, bootstrap: { src: plan.bootstrap.src }, appDefinitionModule: M + '.appDefinition', appInfo: plan.appInfo };
  const rt = await vm.runInContext('(' + createO11BrowserRuntime.toString() + ')(' + JSON.stringify(contract) + ')', p.context);
  const result = plain(await rt.authenticate({ username: 'u'.repeat(48), password: 'p'.repeat(48) }, login));
  assert.deepEqual(result, { loginAnswered: true, registered: true, userIdentified: true });
  assert.deepEqual(plain(order), [['initialize', M, 1], ['modules', 'object'], ['script-map', runtime.moduleVersion, false], ['require-configure', true],
    ['login', 'u'.repeat(48), 'p'.repeat(48), false, 120], ['roles', 'roles-text'], 'registered', 'controller-dispose']);
  assert.equal(p.sandbox.__versions.default.cachedAppInfo.manifest.versionToken, runtime.moduleVersion);
  assert.equal(required.includes('OutSystems/ReactView/Main'), false); assert.equal(p.loaded.includes(plan.bootstrap.src), false);
  await assert.rejects(rt.authenticate({}, login), /realm_invalid/);
  assert.deepEqual(plain(rt.discard()), { discarded: true }); assert.equal(p.storage.cleared, 2);
});

test('mount coordinator: one journaled bootstrap after confirmed sign-in and a started inspector; a lost reply is uncertain', async () => {
  const authorization = { ...mountAuthorization, staticEffectsQualified: false, developmentProved: true, bootstrapQualified: true,
    sourceSha256: 'c'.repeat(64), bootstrapSha256: 'd'.repeat(64) };
  const journal = [], base = { runtimeHandle: '__ssamO11Runtime_' + 'a'.repeat(48), authentication: { receipt: () => ({ confirmed: true }) },
    inspection: { receipt: () => ({ started: true, closed: false }) }, authorization,
    beforeMount: async m => { journal.push(['submission', m]); return { recorded: true }; }, recordOutcome: async m => { journal.push(['result', m]); return { recorded: true }; } };
  let evaluations = 0;
  const ok = createO11BrowserMount({ ...base, page: { evaluate: async () => { evaluations++; return { invoked: true, callbackReturned: true }; } } });
  assert.equal((await ok.mount()).startupCallbackReturned, true); await assert.rejects(ok.mount(), /already_attempted/);
  assert.equal(evaluations, 1); assert.deepEqual(journal.map(j => j[0]), ['submission', 'result']); assert.equal(journal[0][1].staticEffectsQualified, false);
  const lost = createO11BrowserMount({ ...base, page: { evaluate: async () => { throw new Error('timeout'); } } });
  await assert.rejects(lost.mount(), /result_uncertain/); assert.equal(lost.receipt().uncertain, true);
  const failed = createO11BrowserMount({ ...base, page: { evaluate: async () => ({ invoked: true, callbackReturned: false }) } });
  await assert.rejects(failed.mount(), /native_mount_failed/);
  for (const patch of [{ authentication: { receipt: () => ({ confirmed: false }) } }, { inspection: { receipt: () => ({ started: false, closed: false }) } },
    { authorization: { ...authorization, staticEffectsQualified: true } }, { authorization: { ...authorization, developmentProved: false } }]) {
    let called = false; const m = createO11BrowserMount({ ...base, ...patch, beforeMount: async () => { called = true; return { recorded: true }; }, page: { evaluate: async () => { called = true; } } });
    await assert.rejects(m.mount(), /session_not_ready|not_authorized/); assert.equal(called, false);
  }
});

test('readiness waits on the original Application.waitForAppReady; the original error page is a known native state', async () => {
  const handle = '__ssamO11Runtime_' + 'a'.repeat(48), expiresAt = new Date(Date.now() + 5000).toISOString();
  const p = page({}); amdRuntime(p.sandbox); p.container.childElementCount = 2;
  const main = await new Promise(r => p.sandbox.require(['OutSystems/ClientRuntime/Main'], r));
  p.sandbox[handle] = { application: () => main.Internal.Application.default };
  const evalPage = { evaluate: async (fn, arg) => vm.runInContext('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', p.context) };
  const ready = await waitForO11BrowserReady({ page: evalPage, runtimeHandle: handle, runtimeUrl: o11FixtureUrl, expiresAt,
    observeErrorPage: async () => ({ observed: true, navigated: false, marked: false }) });
  assert.deepEqual([ready.nativeApplicationReady, ready.nativePromiseCompleted, ready.routerRendered, ready.lifecycleComplete], [true, true, true, false]);
  const error = await waitForO11BrowserReady({ page: { evaluate: async () => { throw new Error('context destroyed'); } }, runtimeHandle: handle,
    runtimeUrl: o11FixtureUrl, expiresAt, observeErrorPage: async () => ({ observed: true, navigated: true, marked: true }) });
  assert.equal(error.errorPageObserved, true); assert.equal(error.nativeApplicationReady, false);
  await assert.rejects(waitForO11BrowserReady({ page: { evaluate: async () => { throw new Error('lost'); } }, runtimeHandle: handle,
    runtimeUrl: o11FixtureUrl, expiresAt, observeErrorPage: async () => ({ observed: false }) }), /unconfirmed/);
});

test('the in-process mount broker tracks native stops, never fires events and closes everything on dispose', async () => {
  const calls = [], events = [];
  let onEvent;
  const host = { receipt: () => ({ initialized: true }), authenticate: async () => { calls.push('auth'); return { authenticated: true, identityMatches: true }; },
    configureInspection: async options => { calls.push('configure:' + typeof options.inspectionExpiresAt); return { url: 'ws://127.0.0.1:1/x', helperName: '__ssamInspection_' + 'a'.repeat(48) }; },
    mount: async () => { calls.push('mount'); return { startupCallbackReturned: true }; }, waitForApplicationReady: async () => ({ nativeApplicationReady: true }),
    observeErrorPage: async () => ({ observed: true }), dispose: async () => { calls.push('host-dispose'); return { completed: true }; } };
  const ownedBrowser = { inspectionUrl: 'ws://127.0.0.1:1/x', receipt: () => ({ scope: 'owned-browser-process', ready: true, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    dispose: async () => ({ completed: true }) };
  const broker = createO11NativeMountBroker({ ownedBrowser, mountAuthorization, beforeBrowserSignIn: async () => ({ recorded: true }),
    recordBrowserSignInResult: async () => ({ recorded: true }), beforeBrowserMount: async () => ({ recorded: true }), recordBrowserMountResult: async () => ({ recorded: true }),
    createHost: async options => { calls.push('host:' + (options.mountAuthorization === mountAuthorization)); return host; },
    connectInspector: async options => { onEvent = options.onEvent; calls.push('connect'); return { command: async () => ({}), close: async () => calls.push('inspector-close') }; } });
  assert.equal(typeof broker.fireEvent, 'undefined'); assert.equal(typeof broker.invokeLifecycle, 'undefined');
  await assert.rejects(broker.mountBrowser(), /execution_unqualified/);
  await broker.prepareBrowser({ runtime: { runtimeUrl: o11FixtureUrl }, binding: {}, prepared: { login }, modelSources: [] });
  await broker.authenticate({ binding: {}, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await broker.configureInspection({ modules: [{ moduleKey, sourceSha256: 'a'.repeat(64) }], onEvent: e => events.push(e.kind) });
  onEvent({ kind: 'paused', stop: 1, frame: 0, frames: [{ elementKey: moduleKey + ':' + screenKey }] });
  let activity = broker.inspectionActivity();
  assert.equal(activity.paused, true); assert.deepEqual(activity.functions, [moduleKey + ':' + screenKey]);
  onEvent({ kind: 'resumed' }); assert.equal(broker.inspectionActivity().paused, false); assert.deepEqual(events, ['paused', 'resumed']);
  await broker.mountBrowser(); assert.equal((await broker.waitForBrowserReady()).nativeApplicationReady, true);
  const cleanup = await broker.dispose();
  assert.equal(cleanup.completed, true); assert.deepEqual(calls.slice(-2), ['inspector-close', 'host-dispose']);
  assert.deepEqual(calls.slice(0, 4), ['host:true', 'auth', 'configure:string', 'connect']);
});

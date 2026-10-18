import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runO11NativeMount, o11MountDecisionFile } from '../debug-o11-native-mount-run.mjs';
import { o11MountPolicy } from '../debug-o11-browser-mount.mjs';

const host = 'fixture-o11.example.com', M = 'Fixture_UI', runtimeUrl = 'https://' + host + '/' + M + '/', screenKey = 'W4JQW+OX20iILeFJFpMkqA';
const moduleKey = 'Mif02PxcH0K7KiABEHTwMg', binding = { lane: 'o11', host, runtimeUrl, module: M, moduleKey, applicationKey: 'Zk8W2PxcH0K7KiABEHTwMg', publishedVersionId: 4870 };
const login = { modelFactory: M + '.Common.Login.mvc$model', controllerFactory: M + '.Common.Login.mvc$controller', method: 'doLogin$ServerAction',
  viewName: 'Common.Login', apiVersion: 'abcdefghijklmnopqrstuv', endpoint: '/' + M + '/screenservices/' + M + '/Common/Login/ServiceAPIDoLogin' };
const INIT = 'OzK7jk5Lo0Wu2dmagSNFog', READY = 'ALQheqsdZEGBVNun+Anl5w', DESTROY = '2anhLIl+6Um49kZrBQtuKQ';
const views = [{ key: screenKey, handlers: [{ handler: 'onInitializeEventHandler', actionKey: INIT }, { handler: 'onReadyEventHandler', actionKey: READY },
  { handler: 'onDestroyEventHandler', actionKey: DESTROY }], absentHandlers: [] }];
const prepared = (mountViews) => ({ entry: { key: INIT, kind: 'ScreenAction', name: 'OnInitialize' }, login, scenarios: [{ name: 'mount', inputs: {} }],
  mount: { screenKey, ...(mountViews ? { views: mountViews } : {}) }, sourceContract: { path: 'contract.json', sha256: 'a'.repeat(64) } });
const input = { op: 'run', lane: 'o11', lifecycle: 'mounted', words: 'Autorizo montar a tela Home do Fixture_UI em DEV para a prova do debugger' };
const verifiedRender = { renderVerified: true, reasons: [], roots: [{ key: screenKey, present: true }],
  bindings: [{ key: screenKey, id: 'Result', present: true, unique: true, nativeRead: true, typeSupported: true, matches: true }] };

function fixture({ decision = true, mount = 'answered', signIn = 'answered', pauses = [], functions = [], render, cleanup = { completed: true }, ready, version = 4870 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-mount-')), calls = [];
  if (decision) { fs.mkdirSync(path.dirname(o11MountDecisionFile(root)), { recursive: true });
    fs.writeFileSync(o11MountDecisionFile(root), JSON.stringify({ schema: 'ssam-debugger-decision/1', decision: 'o11-owned-browser-mount', approved: true,
      decidedAt: '2026-10-10T00:00:00.000Z', source: 'fixture' })); }
  let activity = { configured: false, paused: false, stops: 0, functions, exceptions: [], lastChangeAt: null, ended: false }, brokerOptions;
  const authorizationExists = () => fs.readdirSync(path.join(root, '.local', 'debugger', 'native-runs', 'o11', host), { withFileTypes: true })
    .some(d => d.isDirectory() && fs.existsSync(path.join(root, '.local', 'debugger', 'native-runs', 'o11', host, d.name, 'authorization.json')));
  const broker = options => {
    brokerOptions = options; calls.push('broker');
    return {
      async prepareBrowser(value) { calls.push('prepare-browser'); assert.equal(value.prepared.login, login); assert.equal(value.binding.sessionId, 'b'.repeat(32)); return { prepared: true, receipt: { initialized: true } }; },
      async authenticate() {
        calls.push('authenticate');
        assert.equal((await options.beforeBrowserSignIn({ endpoint: login.endpoint })).recorded, true);
        assert.equal((await options.beforeBrowserSignIn({ endpoint: login.endpoint })).recorded, false);
        if (signIn === 'lost') { await options.recordBrowserSignInResult({ answered: false, transportUnconfirmed: true }); throw new Error('debug_o11_browser_authentication_sign_in_uncertain'); }
        await options.recordBrowserSignInResult({ answered: true, status: 200, accepted: true });
        activity = { ...activity, configured: true, lastChangeAt: Date.now() }; return { authenticated: true, identityMatches: true };
      },
      inspectionActivity: () => { const next = pauses.shift(); if (next) activity = { ...activity, ...next, lastChangeAt: Date.now() }; return { ...activity, functions: [...activity.functions] }; },
      ...(render ? { async observeBrowserRender() { calls.push('render'); return structuredClone(render); } } : {}),
      async mountBrowser() {
        calls.push('mount');
        assert.equal((await options.beforeBrowserMount({ policy: o11MountPolicy, staticEffectsQualified: false })).recorded, true);
        assert.equal((await options.beforeBrowserMount({ policy: o11MountPolicy })).recorded, false);
        if (mount === 'lost') throw new Error('debug_o11_browser_mount_result_uncertain');
        const outcome = mount === 'native-failed' ? { invoked: true, callbackReturned: false } : { invoked: true, callbackReturned: true };
        assert.equal((await options.recordBrowserMountResult(outcome)).recorded, true);
        if (mount === 'native-failed') throw new Error('debug_o11_browser_mount_native_mount_failed');
        return { nativeBootstrapInvoked: true, startupCallbackReturned: true, lifecycleComplete: false };
      },
      async waitForBrowserReady() { calls.push('ready'); if (ready instanceof Error) throw ready; return ready ?? { nativeApplicationReady: true, nativePromiseCompleted: true, routerRendered: true }; },
      async observeBrowserErrorPage() { calls.push('error-page'); return { observed: true, navigated: true, marked: true }; },
      async dispose() { calls.push('dispose'); return cleanup; } };
  };
  const services = { root, requireClientInspection: true, broker, settleMs: 30, pollMs: 5, sessionId: 'b'.repeat(32), chromeExecutable: 'C:/chrome.exe',
    blocked: () => null,
    acquire: async (value) => { calls.push('acquire'); assert.equal(authorizationExists(), true); assert.equal(value.versionId, 4870);
      return { runtimeUrl, module: M, moduleVersion: 'token', versionId: version, pins: { 'index.html': { sha256: 'd'.repeat(64) } } }; },
    planAssets: () => { calls.push('plan'); return { bootstrap: { bootstrapQualified: true, sha256: 'e'.repeat(64) }, appDefinition: { developmentProved: true }, versionToken: 'token', versionId: version }; },
    launchBrowser: async options => { calls.push('launch'); assert.ok(options.directory.startsWith(root)); return { dispose: async () => { calls.push('browser-dispose'); return { completed: true }; } }; },
    prepareUser: async (target, { sessionId }) => { calls.push('sign-in'); assert.equal(target.lane, 'o11');
      return { ok: true, descriptor: { binding: { lane: 'o11', runtimeUrl, module: M, sessionId }, expiresAt: new Date(Date.now() + 60000).toISOString() } }; },
    releaseUser: async () => { calls.push('release'); return { ok: true }; }, sameTarget: () => true };
  const readers = { binding, sourceContract: { sha256: 'A'.repeat(64) }, clientInspectionModels: async () => ['producer'], verifyPublication: async () => { calls.push('publication'); } };
  const lock = path.join(root, '.local', 'debugger', 'native-runs', 'o11', host, moduleKey + '.lock');
  return { root, calls, services, readers, lock, options: () => brokerOptions };
}

test('refusals that need no live state come before any lock, authorization, download or browser', async () => {
  for (const [request, patch, p, expected] of [[{ ...input, words: ' ' }, {}, prepared(), /explicit_authorization_required/],
    [input, { requireClientInspection: false }, prepared(), /client_inspection_required/],
    [{ ...input, context: { screen: { inputs: { Id: 1 } } } }, {}, prepared(), /screen_inputs_unsupported/],
    [input, {}, { ...prepared(), scenarios: [{ name: 'a', inputs: { Id: 1 } }] }, /screen_inputs_unsupported/],
    [input, {}, { ...prepared(), scenarios: [{ name: 'a' }, { name: 'b' }] }, /screen_inputs_unsupported/],
    [input, {}, { ...prepared(), mount: { screenKey, navigation: { screenKey } } }, /navigation_unsupported/],
    [input, {}, { ...prepared(), mount: { screenKey, interactions: [{}] } }, /interactions_unsupported/],
    [input, {}, { ...prepared(), mount: { screenKey, route: { default: false, segment: 'X' } } }, /route_unsupported/],
    [input, {}, { ...prepared(), login: { ...login, endpoint: '/Other/screenservices/x' } }, /login_contract_required/]]) {
    const f = fixture();
    await assert.rejects(runO11NativeMount(request, p, f.readers, { ...f.services, ...patch }), expected);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.lock), false);
  }
  // The user's decision for an O11 owned-browser mount must be recorded.
  const undecided = fixture({ decision: false });
  await assert.rejects(runO11NativeMount(input, prepared(), undecided.readers, undecided.services), /decision_unrecorded/);
  assert.deepEqual(undecided.calls, []); assert.equal(fs.existsSync(undecided.lock), false);
});

test('authorized mount records the words before any download or browser, takes the binding lock and follows the original order', async () => {
  const f = fixture(), report = await runO11NativeMount(input, prepared(), f.readers, f.services);
  assert.deepEqual(f.calls, ['acquire', 'plan', 'publication', 'launch', 'broker', 'prepare-browser', 'sign-in', 'authenticate', 'publication', 'mount', 'ready', 'dispose', 'release']);
  assert.equal(report.ok, true); assert.equal(report.state, 'answered'); assert.equal(report.uncertain, false);
  assert.equal(report.lane, 'o11'); assert.equal(report.lifecycle, 'mounted'); assert.equal(report.mountPolicy, o11MountPolicy);
  assert.equal(report.staticEffectsQualified, false); assert.equal(report.applicationReady, true); assert.equal(report.lifecycleSettled, true);
  assert.equal(report.lifecycleComplete, false); assert.equal(report.renderVerified, false);
  assert.ok(report.lifecycleIncompleteReasons.includes('handlers-undeclared')); assert.ok(report.lifecycleIncompleteReasons.includes('render-unverified'));
  assert.equal(report.render.error, 'debug_o11_native_mount_render_unavailable');
  assert.equal(report.lockRetained, false); assert.equal(fs.existsSync(f.lock), false);
  const dir = path.dirname(report.receiptPath), authorization = JSON.parse(fs.readFileSync(path.join(dir, 'authorization.json'), 'utf8'));
  // CX15 r5 (N-3, converted): the file keeps wordsSha256 of the words, never the words (before: words === input.words).
  assert.equal(authorization.words, undefined); assert.equal(authorization.wordsSha256, createHash('sha256').update(input.words).digest('hex')); assert.equal(authorization.policy, o11MountPolicy); assert.equal(authorization.decision.decision, 'o11-owned-browser-mount');
  assert.deepEqual(f.options().mountAuthorization, { policy: o11MountPolicy, authorizationSha256: report.authorizationSha256, runtimeUrl, screenKey });
  for (const name of ['sign-in-submission', 'sign-in-result', 'mount-submission', 'mount-result'])
    assert.equal(fs.existsSync(path.join(dir, name + '.json')), true, name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'mount-result.json'), 'utf8')).metadata.callbackReturned, true);
  assert.equal(report.assets.bootstrapQualified, true); assert.equal(report.assets.developmentProved, true);
  // A concurrent run on the same binding meets the lock.
  fs.writeFileSync(f.lock, '{}');
  await assert.rejects(runO11NativeMount(input, prepared(), f.readers, f.services), /binding_busy/);
});

test('a lost mount reply is uncertain, keeps the lock and is never resubmitted; a confirmed failure is failed', async () => {
  const lost = fixture({ mount: 'lost' }), a = await runO11NativeMount(input, prepared(), lost.readers, lost.services);
  assert.equal(a.state, 'uncertain'); assert.equal(a.ok, false); assert.equal(a.lockRetained, true); assert.equal(fs.existsSync(lost.lock), true);
  assert.equal(lost.calls.filter(c => c === 'mount').length, 1); assert.ok(lost.calls.includes('dispose')); assert.ok(lost.calls.includes('release'));
  assert.equal(a.lifecycleComplete, false);
  await assert.rejects(runO11NativeMount(input, prepared(), lost.readers, lost.services), /binding_busy/);
  const failed = fixture({ mount: 'native-failed' }), b = await runO11NativeMount(input, prepared(), failed.readers, failed.services);
  assert.equal(b.state, 'failed'); assert.equal(b.uncertain, false); assert.equal(b.error, 'debug_o11_browser_mount_native_mount_failed');
  assert.equal(b.lockRetained, false); assert.equal(failed.calls.includes('ready'), false);
});

test('a lost sign-in reply is uncertain; a changed publication refuses before the browser', async () => {
  const lost = fixture({ signIn: 'lost' }), a = await runO11NativeMount(input, prepared(), lost.readers, lost.services);
  assert.equal(a.state, 'uncertain'); assert.equal(a.lockRetained, true); assert.equal(lost.calls.includes('mount'), false);
  const changed = fixture({ version: 4871 }), b = await runO11NativeMount(input, prepared(), changed.readers, changed.services);
  assert.equal(b.error, 'debug_o11_native_mount_publication_changed'); assert.equal(changed.calls.includes('launch'), false); assert.equal(b.lockRetained, false);
});

test('the publication re-check is required and its own error code reaches the receipt at each phase', async () => {
  const missing = fixture(); delete missing.readers.verifyPublication;
  await assert.rejects(runO11NativeMount(input, prepared(), missing.readers, missing.services), /publication_check_required/);
  assert.deepEqual(missing.calls, []); assert.equal(fs.existsSync(missing.lock), false);
  for (const [failAt, phase, reached] of [[1, 'publication-before-browser', 'launch'], [2, 'publication-before-mount', 'mount']]) {
    const f = fixture(); let checks = 0;
    f.readers.verifyPublication = async () => { if (++checks === failAt) throw new Error('debug_o11_native_mount_publication_changed'); };
    const report = await runO11NativeMount(input, prepared(), f.readers, f.services);
    assert.equal(report.error, 'debug_o11_native_mount_publication_changed'); assert.equal(report.failurePhase, phase);
    assert.equal(f.calls.includes(reached), false); assert.equal(report.lockRetained, false);
  }
  const opaque = fixture(); opaque.readers.verifyPublication = async () => { throw new Error('ENOENT: inventory'); };
  assert.equal((await runO11NativeMount(input, prepared(), opaque.readers, opaque.services)).error, 'debug_o11_native_mount_publication_check_failed');
});

test('authorization.json (wx) is written before the binding lock is taken', async () => {
  const f = fixture(), folder = path.join(f.root, '.local', 'debugger', 'native-runs', 'o11', host);
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(f.lock, '{"operationId":"other"}');
  await assert.rejects(runO11NativeMount(input, prepared(), f.readers, f.services), /binding_busy/);
  // The words were recorded first; the other run's lock and latest receipt are untouched.
  const dirs = fs.readdirSync(folder, { withFileTypes: true }).filter(d => d.isDirectory());
  assert.equal(dirs.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(folder, dirs[0].name, 'authorization.json'), 'utf8')).wordsSha256, createHash('sha256').update(input.words).digest('hex')); // CX15 r5 (N-3, converted)
  assert.equal(fs.readFileSync(f.lock, 'utf8'), '{"operationId":"other"}'); assert.equal(fs.existsSync(path.join(folder, moduleKey + '.json')), false);
  assert.deepEqual(f.calls, []);
});

const id = key => moduleKey + ':' + key;
test('lifecycleComplete and renderVerified stay false until native and DOM evidence compute them', async () => {
  const f = fixture({ functions: [INIT, READY, DESTROY].map(id), render: verifiedRender, pauses: [{ paused: true, stops: 1 }, {}, { paused: false }] });
  const report = await runO11NativeMount(input, prepared(views), f.readers, f.services);
  assert.equal(report.state, 'answered'); assert.deepEqual(report.handlerCoverage.notObserved, []);
  assert.equal(report.renderVerified, true); assert.equal(report.results[0].renderVerified, true);
  // Every handler stopping is still not a complete lifecycle without OnDestroy after an authorized navigation.
  assert.equal(report.lifecycleComplete, false); assert.deepEqual(report.lifecycleIncompleteReasons, ['navigation-unavailable']);
  const unsettled = fixture({ functions: [INIT].map(id), pauses: [{ paused: true, stops: 1 }, ...Array(400).fill({ paused: true })] });
  unsettled.services.prepareUser = async (target, { sessionId }) => ({ ok: true, descriptor: { binding: { lane: 'o11', runtimeUrl, module: M, sessionId },
    expiresAt: new Date(Date.now() + 300).toISOString() } });
  const r = await runO11NativeMount(input, prepared(views), unsettled.readers, unsettled.services);
  assert.equal(r.lifecycleSettled, false); assert.equal(r.renderVerified, false); assert.ok(r.lifecycleIncompleteReasons.includes('lifecycle-unsettled'));
  const dirty = fixture({ functions: [INIT, READY, DESTROY].map(id), cleanup: { completed: false } });
  const d = await runO11NativeMount(input, prepared(views), dirty.readers, dirty.services);
  assert.equal(d.state, 'uncertain'); assert.ok(d.lifecycleIncompleteReasons.includes('cleanup-incomplete'));
});

test('the original error page after the bootstrap is a known native failure, not uncertainty', async () => {
  const f = fixture({ ready: { nativeApplicationReady: false, nativePromiseCompleted: false, errorPageObserved: true, errorPage: { navigated: true, marked: true } } });
  const report = await runO11NativeMount(input, prepared(), f.readers, f.services);
  assert.equal(report.state, 'failed'); assert.equal(report.error, 'debug_o11_native_mount_error_page_observed');
  assert.equal(report.lifecycleException.knownNativeFailure, true); assert.equal(report.uncertain, false);
});

test('mounted O11 runs never use invokeO11Lifecycle or fireEvent', () => {
  const dir = path.dirname(fileURLToPath(new URL('../debug-o11-native-mount-run.mjs', import.meta.url)));
  for (const file of ['debug-o11-native-mount-run.mjs', 'debug-o11-native-browser-host.mjs', 'debug-o11-browser-mount.mjs', 'debug-o11-browser-assets.mjs', 'debug-o11-browser-authentication.mjs']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /invokeO11Lifecycle|fireEvent|debug-o11-native-context\.mjs|dispatchEvent/, file);
  }
});

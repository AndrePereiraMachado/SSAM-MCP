// CX15 r7: the ODC native mount runner on fakes (the fixture of debug-odc-native-mount-run.test.mjs, trimmed to the
// answered path by the cx15-6 review, C:\t\revisoes\cx15-6\review\repros\d1-debugger-marker.test.mjs). Synthetic values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { odcMountPolicy } from '../../debug-odc-browser-mount.mjs';
// ---- (3) the ODC mount runner, with the fixture of debug-odc-native-mount-run.test.mjs (trimmed to the answered path).
export const runtimeUrl = 'https://fixture-dev.example.app/Fixture/', screenKey = 'W4JQW+OX20iILeFJFpMkqA';
const binding = { lane: 'odc', tenant: 'fixture.outsystems.dev', module: 'Fixture', moduleKey: '7WNw7ud8AEKh1ftGQYhllg', runtimeUrl, revision: 3, environmentKey: 'dev-stage' };
const blockKey = 'RDyePs1DwUyB5poRbGhwVA';
export const prepared = () => ({ entry: { key: 'OzK7jk5Lo0Wu2dmagSNFog', kind: 'ScreenAction', name: 'ScreenOnInitialize' },
  scenarios: [{ name: 'scenario-1', inputs: {} }], mount: { screenKey }, effects: ['unknown-javascript'], sourceContract: { path: 'model.oml', sha256: 'A'.repeat(64) } });
const render = { renderVerified: true, reasons: [], compared: 1, roots: [{ key: screenKey, present: true }, { key: blockKey, present: true }],
  bindings: [{ key: screenKey, id: 'ResultValue', variable: 'Result', present: true, unique: true, nativeRead: true, typeSupported: true, matches: true }] };
export function mountFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx156-d1-')), calls = [];
  let activity = { configured: false, paused: false, stops: 0, functions: [], lastChangeAt: null, ended: false };
  const broker = options => ({
    async prepareBrowser() { calls.push('prepare-browser'); return { prepared: true, receipt: { initialized: true } }; },
    async resolveBrowserViewResources(key) { calls.push('view-resources:' + key); return { viewResourcesPinned: true, resources: [] }; },
    async authenticate() { calls.push('authenticate'); activity = { ...activity, configured: true, lastChangeAt: Date.now() }; return { authenticated: true, identityMatches: true }; },
    inspectionActivity: () => ({ ...activity, functions: [...activity.functions] }),
    async observeBrowserRender() { calls.push('render'); return structuredClone(render); },
    async mountBrowser() {
      calls.push('mount');
      await options.beforeBrowserMount({ policy: odcMountPolicy, sourceSha256: 'c'.repeat(64) });
      await options.recordBrowserMountResult({ invoked: true, callbackReturned: true });
      return { nativeBootstrapInvoked: true, startupCallbackReturned: true, lifecycleComplete: false, mountedVerified: false };
    },
    async waitForBrowserReady() { calls.push('ready'); return { nativeApplicationReady: true, nativePromiseCompleted: true, lifecycleComplete: false }; },
    async dispose() { calls.push('dispose'); return { completed: true }; } });
  const services = { root, requireClientInspection: true, broker, settleMs: 30, pollMs: 5, sessionId: 'a'.repeat(32),
    acquire: async () => { calls.push('acquire'); return { runtimeUrl, moduleVersion: 'v1', pins: { 'index.html': { sha256: 'd'.repeat(64) } }, index: {} }; },
    acquireStyles: async () => { calls.push('styles'); return { pins: { 'style.css': { sha256: 'e'.repeat(64) } } }; },
    chromeExecutable: 'C:/chrome.exe',
    launchBrowser: async () => { calls.push('launch'); return { dispose: async () => { calls.push('browser-dispose'); return { completed: true }; } }; },
    prepareUser: async (target, { sessionId }) => { calls.push('sign-in'); return { ok: true, descriptor: { binding: { lane: 'odc', runtimeUrl, module: 'Fixture', sessionId }, expiresAt: new Date(Date.now() + 60000).toISOString() } }; },
    releaseUser: async () => { calls.push('release'); return { ok: true }; }, sameTarget: () => true };
  const readers = { binding, sourceContract: { sha256: 'A'.repeat(64) }, runtime: { moduleVersion: 'v1' }, clientInspectionModels: async () => ['producer'], verifyPublication: async () => { calls.push('publication'); } };
  return { root, calls, services, readers };
}

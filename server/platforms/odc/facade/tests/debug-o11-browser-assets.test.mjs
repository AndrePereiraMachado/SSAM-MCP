import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planO11BrowserAssets, installO11BrowserAssets, acquireO11BrowserAssets, qualifyO11Bootstrap, qualifyO11AppDefinition } from '../debug-o11-browser-assets.mjs';
import { writeO11MountFixture, o11FixtureBootstrap, o11FixtureAppDefinition, o11FixtureUrl, o11FixtureOrigin, o11FixtureModule as M } from './fixtures/debug-o11-mount-fixture.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-assets-'));
const sha = text => createHash('sha256').update(text).digest('hex');

test('plan serves the pinned document with every script removed and keeps the original classic order outside the deferred bootstrap', () => {
  const runtime = writeO11MountFixture(temp()), plan = planO11BrowserAssets(runtime);
  assert.equal(plan.url, o11FixtureUrl);
  const document = plan.assets.get(o11FixtureUrl);
  assert.equal(document.contentType, 'text/html'); assert.doesNotMatch(document.body, /<script/i);
  assert.match(document.body, /reactContainer/); assert.match(document.body, /css\/_Basic\.css/);
  assert.equal(document.originalSha256, runtime.pins['index.html'].sha256);
  assert.deepEqual(plan.steps.map(s => s.kind === 'script' ? s.name : s.kind), ['basePath', 'OutSystemsManifestLoader.js', 'OutSystems.js',
    'OutSystemsSettings.js', 'Debugger.js', M + '.appDefinition.js', 'indexVersionToken']);
  assert.equal(plan.steps[0].value, '/' + M + '/'); assert.equal(plan.steps.at(-1).value, 'lMo2PVvJ4vvkAwjP5zW2Nw');
  assert.equal(plan.bootstrap.name, M + '.index.js'); assert.equal(plan.bootstrap.bootstrapQualified, true);
  assert.equal(plan.bootstrap.src, o11FixtureUrl + 'scripts/' + M + '.index.js' + runtime.pins['scripts/' + M + '.index.js'].query);
  // The native-shell viewport script is never executed; only its hash is kept.
  assert.equal(plan.removedScripts.filter(s => s.kind === 'inline-skipped').length, 1);
  assert.equal(plan.appDefinition.developmentProved, true); assert.equal(plan.appDefinition.userProviderName, 'Users');
  assert.equal(plan.appDefinition.homeModuleControllerName, M + '.controller');
  assert.equal(plan.versionToken, runtime.moduleVersion); assert.equal(plan.versionId, runtime.versionId);
});

test('only the reviewed bootstrap shape, a Development app definition and pinned index scripts qualify', () => {
  const variants = [
    [{ bootstrap: o11FixtureBootstrap().replace('OSView.Router.load(OS.Application.default);', 'OSView.Router.load(OS.Application.default);window.x=1;') }, /bootstrap_unqualified/],
    [{ bootstrap: o11FixtureBootstrap().replace('InitializationType.Full', 'InitializationType.Minimal') }, /bootstrap_unqualified/],
    [{ appDefinition: o11FixtureAppDefinition({ environmentName: 'Production' }) }, /development_unproved/],
    [{ appDefinition: o11FixtureAppDefinition({ debugEnabled: false }) }, /development_unproved/]];
  for (const [options, expected] of variants) assert.throws(() => planO11BrowserAssets(writeO11MountFixture(temp(), options)), expected);
  // Index token differing from the manifest index version.
  const tokenRuntime = writeO11MountFixture(temp());
  const html = fs.readFileSync(tokenRuntime.pins['index.html'].path, 'utf8').replace('indexVersionToken = "lMo2PVvJ4vvkAwjP5zW2Nw"', 'indexVersionToken = "Changed0000000000000000"');
  fs.writeFileSync(tokenRuntime.pins['index.html'].path, html); tokenRuntime.pins['index.html'].sha256 = sha(html);
  assert.throws(() => planO11BrowserAssets(tokenRuntime), /index_version_mismatch/);
  // A script whose query differs from its pin, or a changed pinned file.
  const queryRuntime = writeO11MountFixture(temp()), q = queryRuntime.pins['scripts/OutSystems.js'].query;
  const changedHtml = fs.readFileSync(queryRuntime.pins['index.html'].path, 'utf8').replace('OutSystems.js' + q, 'OutSystems.js?other');
  fs.writeFileSync(queryRuntime.pins['index.html'].path, changedHtml); queryRuntime.pins['index.html'].sha256 = sha(changedHtml);
  assert.throws(() => planO11BrowserAssets(queryRuntime), /script_unpinned/);
  const changed = writeO11MountFixture(temp()); fs.appendFileSync(changed.pins['scripts/OutSystems.js'].path, '//x');
  assert.throws(() => planO11BrowserAssets(changed), /asset_changed/);
  assert.equal(qualifyO11Bootstrap(o11FixtureBootstrap('Other_UI'), M).bootstrapQualified, false);
  // Published files may start with a BOM and use CRLF.
  assert.equal(qualifyO11AppDefinition('\uFEFF' + o11FixtureAppDefinition().replaceAll('\n', '\r\n'), M).developmentProved, true);
  assert.equal(qualifyO11Bootstrap('\uFEFF' + o11FixtureBootstrap().replaceAll('\n', '\r\n'), M).bootstrapQualified, true);
});

function fakePage() {
  const listeners = {}, sent = [];
  return { sent, listeners, async send(method, params) { sent.push([method, params]); return {}; }, on(event, fn) { listeners[event] = fn; } };
}
async function paused(page, request, resourceType = 'Script') {
  const before = page.sent.length; let id = 'r' + Math.random();
  page.listeners['Fetch.requestPaused']({ requestId: id, request: { method: 'GET', headers: {}, ...request }, resourceType });
  for (let i = 0; i < 50 && page.sent.length === before; i++) await new Promise(r => setImmediate(r));
  const [method, params] = page.sent.at(-1);
  return { method, params, body: params.body ? Buffer.from(params.body, 'base64').toString('utf8') : undefined };
}

test('the boundary serves only pinned document, AMD scripts, moduleinfo and CSS; every other request is refused or guarded', async () => {
  const runtime = writeO11MountFixture(temp()), plan = planO11BrowserAssets(runtime), page = fakePage(), guarded = [];
  const boundary = await installO11BrowserAssets(page, plan, { request: async (request, type) => {
    guarded.push([request.method, new URL(request.url).pathname, type]);
    return request.url.includes('/screenservices/') ? { status: 200, body: '{"data":{}}', headers: [] } : undefined; } });
  assert.deepEqual(page.sent.map(s => s[0]), ['Network.enable', 'Network.setBypassServiceWorker', 'Network.setBlockedURLs', 'Fetch.enable']);
  const doc = await paused(page, { url: o11FixtureUrl }, 'Document');
  assert.equal(doc.method, 'Fetch.fulfillRequest'); assert.doesNotMatch(doc.body, /<script/i);
  assert.ok(doc.params.responseHeaders.some(h => h.name === 'Content-Security-Policy' && /default-src 'none'/.test(h.value)));
  assert.equal((await paused(page, { url: o11FixtureUrl + '?x=1' }, 'Document')).method, 'Fetch.failRequest');
  assert.equal((await paused(page, { url: o11FixtureUrl + 'index.html' }, 'Document')).method, 'Fetch.failRequest');
  const script = 'scripts/' + M + '.MainFlow.Home.mvc.js', pin = runtime.pins[script];
  const served = await paused(page, { url: o11FixtureUrl + script + pin.query });
  assert.equal(served.method, 'Fetch.fulfillRequest'); assert.equal(served.body, fs.readFileSync(pin.path, 'utf8'));
  assert.equal((await paused(page, { url: o11FixtureUrl + script + '?other' })).method, 'Fetch.failRequest');
  assert.equal((await paused(page, { url: o11FixtureUrl + script })).method, 'Fetch.failRequest');
  assert.equal((await paused(page, { url: o11FixtureUrl + 'scripts/Unpinned.js?abc' })).method, 'Fetch.failRequest');
  assert.equal((await paused(page, { url: o11FixtureUrl + script + pin.query, method: 'POST' })).method, 'Fetch.failRequest');
  const css = await paused(page, { url: o11FixtureUrl + 'css/_Basic.css' + runtime.pins['css/_Basic.css'].query }, 'Stylesheet');
  assert.equal(css.method, 'Fetch.fulfillRequest'); assert.ok(css.params.responseHeaders.some(h => h.value === 'text/css'));
  for (const query of ['?cached', '?1760000000000']) {
    const info = await paused(page, { url: o11FixtureUrl + 'moduleservices/moduleinfo' + query }, 'XHR');
    assert.equal(info.method, 'Fetch.fulfillRequest'); assert.equal(info.body, fs.readFileSync(runtime.pins['moduleinfo.json'].path, 'utf8'));
  }
  assert.equal((await paused(page, { url: o11FixtureUrl + 'moduleservices/moduleinfo?a=b&c' }, 'XHR')).method, 'Fetch.failRequest');
  // Everything else reaches only the guarded host transport, which may refuse it.
  assert.equal((await paused(page, { url: 'https://cdn.example.org/x.js' })).method, 'Fetch.failRequest');
  assert.equal((await paused(page, { url: o11FixtureUrl + 'img/logo.png?q' }, 'Image')).method, 'Fetch.failRequest');
  const post = await paused(page, { url: o11FixtureUrl + 'screenservices/' + M + '/ActionX', method: 'POST', postData: '{}' }, 'XHR');
  assert.equal(post.method, 'Fetch.fulfillRequest');
  assert.deepEqual(guarded, [['GET', '/' + M + '/index.html', 'Document'], ['GET', '/x.js', 'Script'], ['GET', '/' + M + '/img/logo.png', 'Image'], ['POST', '/' + M + '/screenservices/' + M + '/ActionX', 'XHR']]);
  const receipt = boundary.receipt();
  assert.ok(receipt.served.every(s => /^[a-f0-9]{64}$/.test(s.originalSha256))); assert.ok(receipt.refused.length >= 8);
  assert.doesNotMatch(JSON.stringify(receipt), /screenservices|postData/);
  assert.equal((await boundary.dispose()).completed, true);
  assert.equal((await paused(page, { url: o11FixtureUrl }, 'Document')).method, 'Fetch.failRequest');
});

test('acquisition pins the published document, scripts, moduleinfo and CSS of the inventoried version only', async () => {
  const source = writeO11MountFixture(temp()), directory = path.join(temp(), 'assets'), requests = [];
  const manifest = JSON.parse(fs.readFileSync(source.pins['moduleinfo.json'].path, 'utf8'));
  const files = Object.fromEntries(Object.entries(source.pins).filter(([, p]) => p.urlPath).map(([, p]) => [p.urlPath + p.query, fs.readFileSync(p.path)]));
  const fetchImpl = async (url, options) => {
    requests.push([options.method, url]); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const u = new URL(url), body = u.pathname === '/' + M + '/moduleservices/moduleinfo' ? fs.readFileSync(source.pins['moduleinfo.json'].path)
      : u.pathname === '/' + M + '/' ? fs.readFileSync(source.pins['index.html'].path) : files[u.pathname + u.search];
    return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 });
  };
  const runtime = await acquireO11BrowserAssets({ binding: { runtimeUrl: o11FixtureUrl, module: M }, versionId: source.versionId, directory, fetchImpl, now: () => 1760000000000 });
  assert.equal(runtime.moduleVersion, manifest.manifest.versionToken); assert.equal(runtime.versionId, source.versionId);
  assert.equal(runtime.pins['index.html'].sha256, source.pins['index.html'].sha256);
  assert.equal(runtime.pins['css/_Basic.css'].sha256, source.pins['css/_Basic.css'].sha256);
  assert.equal(runtime.pins['scripts/OutSystems.js'].query, source.pins['scripts/OutSystems.js'].query);
  assert.ok(requests.every(([method, url]) => method === 'GET' && url.startsWith(o11FixtureOrigin + '/' + M + '/')));
  assert.equal(planO11BrowserAssets(runtime).bootstrap.bootstrapQualified, true);
  await assert.rejects(acquireO11BrowserAssets({ binding: { runtimeUrl: o11FixtureUrl, module: M }, versionId: source.versionId + 1,
    directory: path.join(temp(), 'other'), fetchImpl, now: () => 1 }), /publication_changed/);
});

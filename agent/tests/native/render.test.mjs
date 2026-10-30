// screen.render in the native core: check-render-request answers the Node table row by row, and in qualification mode
// with a test installation (--runtime-root, whose pack.json names a stand-in renderer: a .cmd that runs
// agent/tests/fixtures/fake-renderer.mjs in the mode written next to it) the hello announces the kind and the call
// answers as the Node agent does: the same checked facts, the deadline, a crash, an output too large, an unknown key, the
// queue, a valueBlob, no ELECTRON_RUN_AS_NODE for the worker and its TEMP removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';
import { renderRows, baseRequest } from '../../agent/tests/fixtures/render-table.mjs';
import { validateRenderRequest } from '../../agent/lib/render-request.mjs';
import { createRenderer } from '../../agent/lib/render.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dll = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll');
const fake = path.join(app, 'agent/tests/fixtures/fake-renderer.mjs');
const windows = process.platform === 'win32';
const native = (args, options = {}) => {
  const exe = process.env.SSAM_NATIVE_EXE;
  return spawnSync(exe || 'dotnet', exe ? args : [dll, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options });
};

test('native check-render-request answers the Node table row by row', { timeout: 120000 }, () => {
  const rows = renderRows();
  const expected = rows.map(row => { try { validateRenderRequest(row.request); return { ok: true }; } catch (error) { return { error: error.code }; } });
  const result = native(['check-render-request'], { input: JSON.stringify(rows.map(row => row.request)) });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  rows.forEach((row, i) => {
    assert.deepEqual(actual[i], expected[i], row.label);
    assert.deepEqual(actual[i], row.expected === 'ok' ? { ok: true } : { error: row.expected }, row.label);
  });
});

async function qualify(t, { env = process.env } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-render-'));
  const root = path.join(base, 'data');
  const install = path.join(base, 'install'); const runtime = path.join(install, 'resources', 'pack');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(install, 'mode.txt'), 'success');
  fs.writeFileSync(path.join(install, 'renderer.cmd'), `@echo off\r\nset /p MODE=<"%~dp0mode.txt"\r\n"${process.execPath}" "${fake}" %MODE% %*\r\n`);
  fs.writeFileSync(path.join(runtime, 'pack.json'), JSON.stringify({ id: 'render-test', lanes: [], files: [], renderer: { kind: 'electron-worker', protocol: 1, path: '../../renderer.cmd', electron: '44.9.2' } }));
  const credential = 'ssam_native_qualification';
  const hub = await fakeHub({ credential });
  const args = ['qualify', '--root', root, '--server', hub.url, '--bridge-port', '9', '--runtime-root', runtime];
  const proc = process.env.SSAM_NATIVE_EXE ? spawn(process.env.SSAM_NATIVE_EXE, args, { windowsHide: true, env }) : spawn('dotnet', [dll, ...args], { windowsHide: true, env });
  let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.stdin.end(credential + '\n');
  const exit = new Promise(resolve => proc.once('exit', resolve));
  t.after(async () => { proc.kill(); await exit; await hub.close(); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await hub.until(() => hub.streams === 1, 30000);
  let serial = 0;
  const call = async (params, { mode = 'success', deadline } = {}) => {
    fs.writeFileSync(path.join(install, 'mode.txt'), mode);
    const id = 'render-' + ++serial;
    hub.send({ t: 'call', id, kind: 'screen.render', params, ...(deadline ? { deadline } : {}) });
    await hub.until(() => hub.results(id).length > 0, 60000);
    return hub.results(id)[0];
  };
  return { root, hub, call, install, stderr: () => stderr };
}

// The native core with the real Electron worker (SSAM_RENDER_E2E=1 and SSAM_ELECTRON_EXE, as tests/app/render-worker-e2e):
// the Windows chain of a release, ssam-agent.exe -> the app executable with --ssam-render-worker, here through a .cmd that
// starts electron.exe on src/main/index.mjs.
const electron = process.env.SSAM_ELECTRON_EXE;
const realSkip = !windows ? 'the stand-in renderer is a .cmd' : process.env.SSAM_RENDER_E2E !== '1' ? 'set SSAM_RENDER_E2E=1 and SSAM_ELECTRON_EXE to run the real Electron render worker'
  : !electron || !fs.existsSync(electron) ? 'SSAM_ELECTRON_EXE does not name an Electron executable' : false;
test('native screen.render with the real Electron worker', { skip: realSkip, timeout: 180000 }, async t => {
  const q = await qualify(t);
  fs.writeFileSync(path.join(q.install, 'renderer.cmd'), `@echo off\r\n"${electron}" "${path.join(app, 'src', 'main', 'index.mjs')}" %*\r\n`);
  const css = '.menu{position:fixed;left:0;top:0;width:320px;height:100%;display:none}.tablet .menu{display:block}.content{margin:64px 0 0 16px;width:300px;height:40px}';
  const html = '<!doctype html><html><head></head><body><div class="menu" data-ssam-key="menu"></div><div class="content" data-ssam-key="content">Hidden words</div></body></html>';
  const { createHash } = await import('node:crypto');
  const sha = text => createHash('sha256').update(text).digest('hex');
  const request = { schema: 'ssam-render-request/1', styles: [{ id: 'osui', sha256: sha(css), css }], documents: [{ id: 's1', sha256: sha(html), html, styles: ['osui'] }],
    viewports: [{ name: 'tablet', width: 768, height: 1024, bodyClasses: ['tablet'] }], probes: { keys: 'all', properties: ['width'], maxElements: 100 },
    image: { format: 'jpeg', quality: 60, maxEdge: 400, fullPage: false }, timeoutMs: 60000 };
  const answer = await q.call(request, { mode: 'unused' });
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 600));
  const view = answer.value.documents[0].viewports[0];
  assert.equal(answer.value.engine.name, 'electron');
  assert.deepEqual(view.elements.find(e => e.k === 'content').coveredBy, { k: 'menu', tag: 'div', classes: ['menu'] });
  assert.equal(answer.value.images.length, 1);
  assert.ok(!JSON.stringify(answer.value).includes('Hidden words'));
  const tmp = path.join(q.root, 'private', 'tmp');
  for (let i = 0; i < 100 && fs.readdirSync(tmp).some(name => name.startsWith('render-')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(fs.readdirSync(tmp).filter(name => name.startsWith('render-')), []);
});

test('native screen.render: announced with a renderer, the same facts as the Node agent, the failures and the queue', { skip: !windows && 'the stand-in renderer is a .cmd', timeout: 180000 }, async t => {
  const q = await qualify(t, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.ok(q.hub.hellos[0].agent.kinds.includes('screen.render'), JSON.stringify(q.hub.hellos[0].agent.kinds));
  const request = { ...baseRequest(), image: { format: 'jpeg', quality: 70, maxEdge: 800, fullPage: false } };
  let answer = await q.call(request);
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 600));
  const node = await createRenderer({ renderer: { path: process.execPath, args: [fake, 'success'] } }).render(request);
  assert.deepEqual(answer.value, node);
  assert.ok(!JSON.stringify(answer.value).includes('SECRET-SCREEN-TEXT'));
  const tmp = path.join(q.root, 'private', 'tmp');
  for (let i = 0; i < 100 && fs.readdirSync(tmp).some(name => name.startsWith('render-')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(fs.readdirSync(tmp).filter(name => name.startsWith('render-')), []);
  answer = await q.call(baseRequest(), { mode: 'env' });
  assert.equal(answer.value.engine.version, 'none');
  for (const [mode, params, code, deadline] of [['crash', baseRequest(), 'RENDER_FAILED'], ['large', baseRequest(), 'RENDER_FAILED'],
    ['unknown', { ...baseRequest(), probes: { keys: ['a1'], properties: [], maxElements: 10 } }, 'RENDER_FAILED'],
    ['sleep', { ...baseRequest(), timeoutMs: 5000 }, 'RENDER_TIMEOUT'], ['sleep', baseRequest(), 'RENDER_TIMEOUT', Date.now() + 1500],
    ['success', renderRows().find(row => row.label === 'a script').request, 'RENDER_DOCUMENT_REFUSED'],
    ['success', { ...baseRequest(), schema: 'x' }, 'RENDER_REQUEST_INVALID']]) {
    answer = await q.call(params, { mode, deadline });
    assert.equal(answer.ok, false, mode);
    assert.equal(answer.error.code, code, mode + ': ' + answer.error.message);
    assert.equal(answer.error.executed, false, mode);
  }
  fs.writeFileSync(path.join(q.install, 'mode.txt'), 'slow');
  for (const id of ['q1', 'q2', 'q3', 'q4']) q.hub.send({ t: 'call', id, kind: 'screen.render', params: baseRequest() });
  await q.hub.until(() => ['q1', 'q2', 'q3', 'q4'].every(id => q.hub.results(id).length > 0), 60000);
  const outcomes = ['q1', 'q2', 'q3', 'q4'].map(id => q.hub.results(id)[0]);
  assert.equal(outcomes.filter(o => o.ok).length, 3, JSON.stringify(outcomes.map(o => o.error?.code ?? 'ok')));
  assert.equal(outcomes.filter(o => o.error?.code === 'RENDER_BUSY').length, 1);
  // A request above the inline limit comes as a paramsBlob and is read into memory: no .json file appears in private/tmp.
  const big = baseRequest(); const bigCss = '.x{color:red}' + ' '.repeat(600 * 1024);
  big.styles = [{ id: 'osui', sha256: (await import('node:crypto')).createHash('sha256').update(bigCss).digest('hex'), css: bigCss }];
  fs.writeFileSync(path.join(q.install, 'mode.txt'), 'success');
  const seen = []; const watcher = fs.watch(path.join(q.root, 'private', 'tmp'), (event, name) => seen.push(String(name)));
  q.hub.send({ t: 'call', id: 'blob-params', kind: 'screen.render', paramsBlob: q.hub.putBlob(Buffer.from(JSON.stringify(big))) });
  await q.hub.until(() => q.hub.results('blob-params').length > 0, 60000);
  watcher.close();
  assert.equal(q.hub.results('blob-params')[0].ok, true, JSON.stringify(q.hub.results('blob-params')[0]).slice(0, 300));
  assert.deepEqual(seen.filter(name => name.endsWith('.json')), []);
  answer = await q.call(baseRequest(), { mode: 'many' });
  assert.ok(answer.valueBlob, JSON.stringify(answer).slice(0, 300));
  const facts = JSON.parse(q.hub.assembled(answer.valueBlob));
  assert.equal(facts.documents[0].viewports[0].elements.length, 1500);
  assert.equal(facts.documents[0].viewports[0].truncated, true);
});

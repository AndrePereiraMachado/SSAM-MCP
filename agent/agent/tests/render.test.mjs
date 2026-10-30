// screen.render on the Node agent (docs/FASE2-AGENTE.md 4.4): the request table (shared with the native core through
// check-render-request), the renderer of the installation (pack.json renderer, inside the installation, present), the
// hello, and a stand-in worker (fixtures/fake-renderer.mjs) for success, the deadline, a crash, an output too large, fields
// that are not facts (dropped), an unknown key, a JPEG too large, the queue (RENDER_BUSY) and a value sent as a valueBlob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRenderRequest, validateRenderFacts, RENDER_KIND } from '../lib/render-request.mjs';
import { resolveRenderer, createRenderer, rendererLine } from '../lib/render.mjs';
import { createAgent, readPack } from '../lib/agent.mjs';
import { helloKinds, KINDS } from '../lib/kinds.mjs';
import { renderRows, baseRequest } from './fixtures/render-table.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-renderer.mjs', import.meta.url));
const rendererFor = mode => ({ path: process.execPath, args: [fake, mode], version: '44.9.2' });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-test-'));

test('screen.render request table: every limit and every refused construct', () => {
  for (const row of renderRows()) {
    let outcome = 'ok';
    try { validateRenderRequest(row.request); } catch (error) { outcome = error.code; assert.equal(error.executed, false, row.label); }
    assert.equal(outcome, row.expected, row.label);
  }
});

test('screen.render request: defaults, and the worker\'s structural check without the text rules', () => {
  const minimal = { ...baseRequest() };
  for (const key of ['styles', 'probes', 'image', 'timeoutMs']) delete minimal[key];
  minimal.documents = minimal.documents.map(d => ({ ...d, styles: [] }));
  const checked = validateRenderRequest(minimal);
  assert.deepEqual(checked.probes, { keys: 'all', properties: [], maxElements: 1500 });
  assert.equal(checked.image, null);
  assert.equal(checked.timeoutMs, 60000);
  const script = renderRows().find(row => row.label === 'a script').request;
  assert.throws(() => validateRenderRequest(script), { code: 'RENDER_DOCUMENT_REFUSED' });
  assert.doesNotThrow(() => validateRenderRequest(script, { documentRules: false }));
});

test('renderer: only pack.json renderer inside the installation, present, protocol 1', t => {
  const base = temp(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = path.join(base, 'SSAM Agent'); const runtime = path.join(install, 'resources', 'pack'); const data = path.join(base, 'data');
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(data);
  fs.writeFileSync(path.join(install, 'SSAM Agent.exe'), 'exe');
  fs.writeFileSync(path.join(base, 'outside.exe'), 'exe');
  fs.writeFileSync(path.join(runtime, 'inside.exe'), 'exe');
  const resolve = renderer => resolveRenderer({ runtimeRoot: runtime, dataRoot: data, pack: { renderer }, platform: 'win32' });
  const good = resolve({ kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe', electron: '44.9.2' });
  assert.equal(good.path, path.join(install, 'SSAM Agent.exe'));
  assert.equal(good.version, '44.9.2');
  assert.equal(rendererLine(good), 'available (Electron 44.9.2)');
  assert.match(resolveRenderer({ runtimeRoot: runtime, dataRoot: data, pack: {}, platform: 'win32' }).reason, /no SSAM Agent app/);
  assert.match(resolve({ kind: 'electron-worker', protocol: 2, path: '../../SSAM Agent.exe' }).reason, /another protocol/);
  assert.match(resolve({ kind: 'chrome', protocol: 1, path: '../../SSAM Agent.exe' }).reason, /another protocol/);
  assert.match(resolve({ kind: 'electron-worker', protocol: 1, path: path.join(install, 'SSAM Agent.exe') }).reason, /not relative/);
  assert.match(resolve({ kind: 'electron-worker', protocol: 1, path: '../../../outside.exe' }).reason, /leaves the installation/);
  assert.match(resolve({ kind: 'electron-worker', protocol: 1, path: 'inside.exe' }).reason, /leaves the installation/);
  assert.match(resolve({ kind: 'electron-worker', protocol: 1, path: '../../Missing.exe' }).reason, /missing/);
  assert.match(rendererLine(resolve({ kind: 'electron-worker', protocol: 1, path: '../../Missing.exe' })), /^not available \(/);
  // readPack keeps the field.
  fs.writeFileSync(path.join(runtime, 'pack.json'), JSON.stringify({ id: 'p', lanes: [], files: [], renderer: { kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe' } }));
  assert.deepEqual(readPack(runtime).renderer, { kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe' });
});

test('hello: screen.render only with a renderer; file.upload always', () => {
  assert.deepEqual(helloKinds(null), [...KINDS]);
  assert.deepEqual(helloKinds({ reason: 'none' }), [...KINDS]);
  assert.deepEqual(helloKinds({ path: 'x' }), [...KINDS, RENDER_KIND]);
  assert.ok(!KINDS.includes(RENDER_KIND));
});

test('stand-in worker: success; fields that are not facts are dropped; the worker gets no ELECTRON_RUN_AS_NODE; its TEMP is removed', async t => {
  const tempRoot = temp(); t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const request = { ...baseRequest(), image: { format: 'jpeg', quality: 70, maxEdge: 800, fullPage: false } };
  const facts = await createRenderer({ renderer: rendererFor('success'), tempRoot }).render(request);
  const text = JSON.stringify(facts);
  assert.ok(!text.includes('SECRET-SCREEN-TEXT'));
  assert.ok(!text.includes('"content"'));
  assert.equal(facts.documents[0].viewports.length, 2);
  const tablet = facts.documents[0].viewports.find(v => v.name === 'tablet');
  assert.deepEqual(tablet.elements[0], { k: 'a1', box: [16, 64, 300.5, 40], visible: true, coveredBy: { k: null, tag: 'div', classes: ['app-menu-content'] }, clippedBy: null,
    lines: 2, textLength: 18, overflowX: false, styles: { 'white-space': 'normal', width: 'normal', 'margin-left': 'normal' } });
  assert.equal(tablet.ms, 12);
  assert.equal(facts.images.length, 2);
  assert.deepEqual(facts.images.map(image => [image.document, image.viewport, image.width, image.height]), [['s1', 'desktop', 800, 768], ['s1', 'tablet', 768, 800]]);
  for (let i = 0; i < 50 && fs.readdirSync(tempRoot).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  const env = await createRenderer({ renderer: rendererFor('env'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).render(baseRequest());
  assert.equal(env.engine.version, 'none');
});

test('stand-in worker: deadline, crash, output too large, unknown key, a JPEG too large, unavailable', { timeout: 60000 }, async () => {
  const run = (mode, request = baseRequest(), options = {}) => createRenderer({ renderer: rendererFor(mode) }).render(request, options);
  const fails = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); assert.equal(error.executed, false); return true; });
  const started = Date.now();
  await fails(run('sleep', { ...baseRequest(), timeoutMs: 5000 }), 'RENDER_TIMEOUT');
  assert.ok(Date.now() - started < 15000);
  await fails(run('sleep', baseRequest(), { deadline: Date.now() + 1500 }), 'RENDER_TIMEOUT');
  await fails(run('success', baseRequest(), { deadline: Date.now() - 1 }), 'RENDER_TIMEOUT');
  await fails(run('crash'), 'RENDER_FAILED');
  await fails(run('large'), 'RENDER_FAILED');
  await fails(run('unknown', { ...baseRequest(), probes: { keys: ['a1'], properties: [], maxElements: 10 } }), 'RENDER_FAILED');
  const omitted = await run('big-image', { ...baseRequest(), image: { format: 'jpeg', quality: 70, maxEdge: 800, fullPage: false } });
  assert.deepEqual(omitted.images, []);
  assert.deepEqual(omitted.imagesOmitted, [{ document: 's1', viewport: 'desktop', reason: 'too-large' }, { document: 's1', viewport: 'tablet', reason: 'too-large' }]);
  assert.equal(omitted.documents[0].viewports[0].image, null);
  await fails(createRenderer({ renderer: { reason: 'this installation has no SSAM Agent app to render with' } }).render(baseRequest()), 'RENDER_UNAVAILABLE');
  await fails(run('success', renderRows().find(row => row.label === 'a script').request), 'RENDER_DOCUMENT_REFUSED');
});

test('stand-in worker: one at a time, two waiting, RENDER_BUSY above', { timeout: 60000 }, async () => {
  const renderer = createRenderer({ renderer: rendererFor('slow') });
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => renderer.render(baseRequest())));
  assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
  assert.equal(outcomes[3].reason.code, 'RENDER_BUSY');
  assert.equal((await renderer.render(baseRequest())).schema, 'ssam-render-facts/1');
});

test('screen.render through the channel: announced with a renderer, answered as a valueBlob above the inline limit', { timeout: 60000 }, async t => {
  const root = makeRoot();
  const hub = await fakeHub({ credential: CREDENTIAL });
  const agent = createAgent({ root, config: { server: hub.url, credential: CREDENTIAL },
    deps: { processes: async () => [], locate: async () => null, machine: null, studioRuntime: async () => null, bridgeProcessSnapshot: async () => [], renderer: rendererFor('many') } });
  t.after(async () => { await agent.stop(); await hub.close(); removeRoot(root); });
  agent.run();
  await hub.until(() => hub.stream);
  assert.ok(hub.hellos[0].agent.kinds.includes('screen.render'));
  assert.ok(hub.hellos[0].agent.kinds.includes('file.upload'));
  hub.send({ t: 'call', id: 'render-1', kind: 'screen.render', params: baseRequest(), deadline: Date.now() + 60000 });
  await hub.until(() => hub.results('render-1').length > 0, 30000);
  const answer = hub.results('render-1')[0];
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 500));
  assert.ok(answer.valueBlob);
  const facts = JSON.parse(hub.assembled(answer.valueBlob));
  assert.equal(facts.documents[0].viewports[0].elements.length, 1500);
  assert.equal(facts.documents[0].viewports[0].truncated, true);
  assert.equal(facts.documents[0].viewports[0].elements[0].styles['white-space'].length, 200);
  // A request above the inline limit comes as a paramsBlob and is read into memory: no file appears in private\tmp.
  const big = baseRequest(); const css = '.x{color:red}' + ' '.repeat(600 * 1024);
  big.styles = [{ id: 'osui', sha256: (await import('node:crypto')).createHash('sha256').update(css).digest('hex'), css }];
  const seen = []; const watcher = fs.watch(path.join(root, 'private', 'tmp'), (event, name) => seen.push(String(name)));
  hub.send({ t: 'call', id: 'render-2', kind: 'screen.render', paramsBlob: hub.putBlob(Buffer.from(JSON.stringify(big))) });
  await hub.until(() => hub.results('render-2').length > 0, 30000);
  watcher.close();
  assert.equal(hub.results('render-2')[0].ok, true, JSON.stringify(hub.results('render-2')[0]).slice(0, 300));
  assert.deepEqual(seen.filter(name => name.endsWith('.json')), []);
  // No renderer: not announced, RENDER_UNAVAILABLE when called anyway.
  const plain = makeRoot();
  const other = createAgent({ root: plain, config: { server: hub.url, credential: CREDENTIAL }, deps: { processes: async () => [], locate: async () => null, machine: null } });
  t.after(() => removeRoot(plain));
  const refused = await other.execute('screen.render', baseRequest());
  assert.equal(refused.error.code, 'RENDER_UNAVAILABLE');
  assert.equal(refused.error.executed, false);
});

test('doctor: the screen render line and the approved folders', async t => {
  const { doctor } = await import('../ssam-agent.mjs');
  const root = makeRoot(); t.after(() => removeRoot(root));
  const report = async () => { const out = { text: '', write(chunk) { out.text += chunk; return true; } };
    await doctor({ root, stdout: out, json: true, deps: { runtimes: async () => '', studios: async () => ({}), env: {} } }); return JSON.parse(out.text); };
  let checks = (await report()).checks;
  assert.match(checks.find(c => c.name === 'screen render').detail, /^not available \(this installation has no SSAM Agent app/);
  assert.equal(checks.find(c => c.name === 'upload folders').detail, '0 approved');
  const install = path.join(root, 'install'); fs.mkdirSync(path.join(install, 'resources', 'pack'), { recursive: true }); fs.writeFileSync(path.join(install, 'SSAM Agent.exe'), 'x');
  fs.writeFileSync(path.join(install, 'resources', 'pack', 'pack.json'), JSON.stringify({ id: 'p', lanes: [], files: [], renderer: { kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe', electron: '44.9.2' } }));
  const out = { text: '', write(chunk) { out.text += chunk; return true; } };
  await doctor({ root: path.join(root, 'data-elsewhere'), runtimeRoot: path.join(install, 'resources', 'pack'), stdout: out, json: true, deps: { runtimes: async () => '', studios: async () => ({}), env: {} } });
  assert.equal(JSON.parse(out.text).checks.find(c => c.name === 'screen render').detail, 'available (Electron 44.9.2)');
});

test('facts check: a result that names another document or viewport is refused', () => {
  const request = validateRenderRequest(baseRequest());
  const facts = { schema: 'ssam-render-facts/1', engine: { name: 'electron', version: '44', chromium: '1', protocol: 1 }, documents: [], images: [] };
  assert.equal(validateRenderFacts(facts, request).documents.length, 0);
  assert.throws(() => validateRenderFacts({ ...facts, documents: [{ id: 'other', viewports: [], errors: [] }] }, request), { code: 'RENDER_FAILED' });
  assert.throws(() => validateRenderFacts({ ...facts, documents: [{ id: 's1', viewports: [{ name: 'phone' }], errors: [] }] }, request), { code: 'RENDER_FAILED' });
  assert.throws(() => validateRenderFacts({ ...facts, engine: { protocol: 2 } }, request), { code: 'RENDER_FAILED' });
  assert.throws(() => validateRenderFacts({ ...facts, documents: [{ id: 's1', viewports: [], errors: [{ code: 'OTHER' }] }] }, request), { code: 'RENDER_FAILED' });
});

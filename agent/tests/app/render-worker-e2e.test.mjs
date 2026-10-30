// The real render worker (src/main/render/worker.mjs) in the Electron of the app's node_modules, only with
// SSAM_RENDER_E2E=1 and SSAM_ELECTRON_EXE (the electron.exe to run; never the installed app, never the panel). The worker
// is started as the agent starts it ("<app> --ssam-render-worker", here electron.exe src/main/index.mjs), offscreen, with a
// temporary userData, on a synthetic document:
//   - a fixed menu that covers content on the tablet viewport only (coveredBy), a pre-wrap label on two lines, a list
//     whose sentinel comes before the first row (the :first-child rule does not reach it), a font that cannot load;
//   - the sandbox: a local HTTP server gets no request (img, url(), @import, @font-face, link, iframe, object, form, meta
//     refresh), a page <script> canary never runs, navigation is blocked;
//   - privacy: no text of the document in the facts; the JPEG decodes at the asked size; the worker's temporary folder is
//     removed.
// The agent's own checks refuse such a document (render-request.mjs); the worker is fed directly here because its sandbox,
// not the text checks, is the barrier. A second case runs the whole agent path with a valid document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateRenderFacts, validateRenderRequest } from '../../agent/lib/render-request.mjs';
import { createRenderer } from '../../agent/lib/render.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const electron = process.env.SSAM_ELECTRON_EXE;
const skip = process.env.SSAM_RENDER_E2E !== '1' ? 'set SSAM_RENDER_E2E=1 and SSAM_ELECTRON_EXE to run the real Electron render worker'
  : !electron || !fs.existsSync(electron) ? 'SSAM_ELECTRON_EXE does not name an Electron executable' : false;
const sha = text => createHash('sha256').update(text).digest('hex');
const SECRET = 'SECRET-TEXT-4711';

function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

const STYLE = `
body { margin: 0; font: 16px/20px Arial, sans-serif; }
.app-menu-content { position: fixed; left: 0; top: 0; width: 320px; height: 100%; background: #222; z-index: 10; display: none; }
.tablet .app-menu-content { display: block; }
.content { margin: 64px 0 0 16px; width: 300px; height: 40px; }
.label { white-space: pre-wrap; width: 400px; margin-left: 400px; }
.list { margin-left: 400px; }
.list > .row:first-child { color: rgb(255, 0, 0); }
.missing-font { font-family: "NoSuchFontXyz", sans-serif; margin-left: 400px; }`;

function syntheticHtml(port, hostile) {
  const outside = `http://127.0.0.1:${port}`;
  return `<!doctype html><html><head><meta charset="utf-8">${hostile ? `
<link rel="stylesheet" href="${outside}/link.css">
<meta http-equiv="refresh" content="0;url=${outside}/refresh">
<style>@import url("${outside}/import.css"); @font-face { font-family: Remote; src: url(${outside}/font.woff); } .bg { background: url(${outside}/bg.png); font-family: Remote; }</style>` : ''}
</head><body>
<div class="app-menu-content" data-ssam-key="menu"></div>
<div class="content" data-ssam-key="content">${SECRET} content</div>
<div class="label" data-ssam-key="label">${SECRET} one
two</div>
<div class="list" data-ssam-key="list"><template data-ssam-sentinel></template><div class="row" data-ssam-key="first">${SECRET} A</div><div class="row" data-ssam-key="second">B</div></div>
<div class="missing-font" data-ssam-key="font">${SECRET}</div>${hostile ? `
<div class="bg" data-ssam-key="bg">x</div>
<img data-ssam-key="img" src="${outside}/img.png" width="10" height="10">
<iframe src="${outside}/frame"></iframe>
<object data="${outside}/object"></object>
<form action="${outside}/form"><input name="q"></form>
<script>document.body.insertAdjacentHTML('beforeend', '<div data-ssam-key="canary">ran</div>'); fetch('${outside}/script');</script>` : ''}
</body></html>`;
}

function request(port, { hostile = false, image = null } = {}) {
  const html = syntheticHtml(port, hostile);
  return { schema: 'ssam-render-request/1', styles: [{ id: 'osui', sha256: sha(STYLE), css: STYLE }],
    documents: [{ id: 's1', sha256: sha(html), html, styles: ['osui'] }],
    viewports: [{ name: 'desktop', width: 1366, height: 768, bodyClasses: ['desktop'] }, { name: 'tablet', width: 768, height: 1024, bodyClasses: ['tablet', 'portrait'] }],
    probes: { keys: 'all', properties: ['white-space', 'color', 'width'], maxElements: 1500 }, image, timeoutMs: 60000 };
}

async function outsideServer(t) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('x'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, hits };
}

function runWorker(input, temp) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(app, 'src', 'main', 'index.mjs'), '--ssam-render-worker'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill(), 90000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(JSON.stringify(input));
  });
}

test('render worker: covered menu, pre-wrap lines, sentinel, missing font; no network, no script, no text; JPEG; temp removed', { skip, timeout: 120000 }, async t => {
  const outside = await outsideServer(t);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-e2e-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = request(outside.port, { hostile: true, image: { format: 'jpeg', quality: 70, maxEdge: 400, fullPage: false } });
  const result = await runWorker(input, temp);
  assert.equal(result.code, 0, result.err.slice(-2000));
  const line = result.out.split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(!line.includes(SECRET), 'no text of the document in the facts');
  const facts = validateRenderFacts(JSON.parse(line), validateRenderRequest(input, { documentRules: false }));
  assert.equal(facts.engine.name, 'electron');
  assert.match(facts.engine.version, /^\d+\./);
  const [document] = facts.documents;
  assert.deepEqual(document.errors, []);
  const view = name => document.viewports.find(v => v.name === name);
  const el = (name, key) => view(name).elements.find(e => e.k === key);
  // The fixed menu covers the content on the tablet only.
  assert.equal(el('desktop', 'menu').visible, false);
  assert.equal(el('desktop', 'content').coveredBy, null);
  assert.deepEqual(el('tablet', 'content').coveredBy, { k: 'menu', tag: 'div', classes: ['app-menu-content'] });
  // pre-wrap keeps the line break: two lines.
  assert.equal(el('desktop', 'label').lines, 2);
  assert.equal(el('desktop', 'label').styles['white-space'], 'pre-wrap');
  assert.ok(el('desktop', 'label').textLength > 0);
  // The sentinel is the first child: the :first-child rule does not reach the first row.
  assert.notEqual(el('desktop', 'first').styles.color, 'rgb(255, 0, 0)');
  assert.ok(view('desktop').fonts.missing.includes('NoSuchFontXyz'), JSON.stringify(view('desktop').fonts));
  assert.ok(view('desktop').fonts.missing.includes('Remote'), JSON.stringify(view('desktop').fonts));
  // The page script never ran, no request left, the page did not navigate away.
  assert.equal(el('desktop', 'canary'), undefined);
  assert.deepEqual(outside.hits, []);
  assert.ok(el('desktop', 'content'));
  // The JPEGs decode at the asked size (the longer side at maxEdge).
  assert.equal(facts.images.length, 2);
  const sizes = facts.images.map(image => jpegSize(Buffer.from(image.base64, 'base64')));
  assert.deepEqual(sizes[0], { width: 400, height: 225 });
  assert.deepEqual(sizes[1], { width: 300, height: 400 });
  assert.deepEqual(facts.images.map(image => [image.width, image.height]), [[400, 225], [300, 400]]);
  // Everything the worker wrote is inside the TEMP it was given (its profile while it runs; the agent removes the folder
  // once the worker has ended, see the next test), and nothing holds it any more.
  assert.ok(fs.readdirSync(temp).every(name => name.startsWith('ssam-render-')), JSON.stringify(fs.readdirSync(temp)));
  fs.rmSync(temp, { recursive: true, maxRetries: 30, retryDelay: 200 });
  assert.equal(fs.existsSync(temp), false);
});

test('render worker through the agent: a valid document, the facts checked, no text', { skip, timeout: 120000 }, async t => {
  const outside = await outsideServer(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-agent-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const renderer = createRenderer({ renderer: { path: electron, args: [path.join(app, 'src', 'main', 'index.mjs')], version: 'test' }, tempRoot });
  const facts = await renderer.render(request(outside.port));
  assert.ok(!JSON.stringify(facts).includes(SECRET));
  const tablet = facts.documents[0].viewports.find(v => v.name === 'tablet');
  assert.equal(tablet.elements.find(e => e.k === 'content').coveredBy.k, 'menu');
  assert.deepEqual(facts.images, []);
  assert.deepEqual(outside.hits, []);
  // The worker's temporary folder is removed by the agent after the worker ended.
  for (let i = 0; i < 100 && fs.readdirSync(tempRoot).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

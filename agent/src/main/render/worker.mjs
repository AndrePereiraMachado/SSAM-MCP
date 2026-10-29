// The render worker of screen.render (docs/FASE2-AGENTE.md 4.4): "<SSAM Agent> --ssam-render-worker", started by the agent
// (agent/lib/render.mjs or the native core) for one call. It reads one ssam-render-request/1 on its standard input,
// renders each document at each viewport and writes one line of ssam-render-facts/1 on its standard output, then exits 0.
// It opens no port, holds no token and never touches the app's own data: index.mjs branches here before the single
// instance lock, and userData, sessionData and the crash folder are a temporary folder of its own, removed at the end.
// The sandbox is the barrier (the agent's text checks of the request are a diagnostic):
//   - an in-memory partition ssam-render-<random>; every request that is not ssam-render: or data: is cancelled;
//   - the documents are served by the ssam-render: protocol with the CSP below (no script, no network, no form, no base);
//   - navigation, redirects, new windows, permissions and downloads are refused;
//   - an offscreen window with sandbox, context isolation, no Node, no devtools; no hardware acceleration;
//   - the measurement (probe.js) runs in an isolated world: a fixed script of this worker, never code from the server.
// Facts carry geometry and computed styles, never text of the screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { app, BrowserWindow, protocol, session } from 'electron';
import { validateRenderRequest, FACTS_SCHEMA, RENDER_PROTOCOL, RENDER_LIMITS } from '../../../agent/lib/render-request.mjs';
import { measure } from './probe.js';
import { composeDocument, RENDER_CSP, RENDER_SCHEME } from './document.mjs';

export const RENDER_WORKER_FLAG = '--ssam-render-worker';
const VIEW_MS = 10000;
const WORLD = 1027;

export const isRenderWorker = (argv = process.argv) => argv.includes(RENDER_WORKER_FLAG);

// The request, read from file descriptor 0 to its end (Electron's main process does not deliver process.stdin from a
// pipe on Windows; the descriptor itself is the pipe the agent writes).
async function readInput() {
  const chunks = []; const buffer = Buffer.alloc(1024 * 1024);
  for (;;) {
    let read;
    try { read = fs.readSync(0, buffer, 0, buffer.length, null); }
    catch (error) { if (error.code === 'EAGAIN') { await new Promise(resolve => setTimeout(resolve, 10)); continue; } if (error.code === 'EOF') break; throw error; }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const within = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' })), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

// The worker's whole life; returns the exit code. Must be called before the app is ready (index.mjs does it at load).
export function runRenderWorker({ output = process.stdout } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-render-'));
  app.setPath('userData', path.join(temp, 'user'));
  app.setPath('sessionData', path.join(temp, 'session'));
  try { app.setPath('crashDumps', path.join(temp, 'crash')); } catch { /* older Electron */ }
  app.setAppLogsPath(path.join(temp, 'logs'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
  protocol.registerSchemesAsPrivileged([{ scheme: RENDER_SCHEME, privileges: { standard: true, secure: true } }]);
  app.on('window-all-closed', () => { /* the worker decides when to quit */ });
  const input = readInput();
  const done = (async () => {
    let code = 0;
    try {
      const request = validateRenderRequest(JSON.parse(await input), { documentRules: false });
      await app.whenReady();
      const facts = await render(request);
      await new Promise(resolve => output.write(JSON.stringify(facts) + '\n', resolve));
    } catch (error) {
      // The agent discards the worker's standard error; it is there for a person running the worker by hand.
      try { process.stderr.write('render worker: ' + String(error?.stack ?? error).slice(0, 2000) + '\n'); } catch { /* no stderr */ }
      code = 1;
    }
    for (const window of BrowserWindow.getAllWindows()) { try { window.destroy(); } catch { /* gone */ } }
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* removed by the next start of the OS cleaner */ }
    app.exit(code);
  })();
  return done;
}

async function render(request) {
  const ses = session.fromPartition('ssam-render-' + randomBytes(8).toString('hex'), { cache: false });
  let current = null;
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(RENDER_SCHEME + ':') || details.url.startsWith('data:')) }));
  ses.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => { event.preventDefault(); try { item.cancel(); } catch { /* not started */ } });
  try { ses.setSpellCheckerEnabled(false); } catch { /* no spell checker */ }
  ses.protocol.handle(RENDER_SCHEME, req => {
    const url = new URL(req.url);
    if (current && url.host === 'doc' && url.pathname === '/' + current.id)
      return new Response(current.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': RENDER_CSP, 'cache-control': 'no-store' } });
    return new Response('', { status: 404, headers: { 'content-security-policy': RENDER_CSP } });
  });
  const documents = []; const images = [];
  for (const document of request.documents) {
    const result = { id: document.id, sha256: document.sha256, viewports: [], errors: [] };
    documents.push(result);
    for (const viewport of request.viewports) {
      const started = Date.now();
      const window = new BrowserWindow({ show: false, width: viewport.width, height: viewport.height, useContentSize: true, frame: false, paintWhenInitiallyHidden: true,
        webPreferences: { session: ses, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
          webviewTag: false, devTools: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, backgroundThrottling: false, disableDialogs: true,
          navigateOnDragDrop: false, autoplayPolicy: 'user-gesture-required' } });
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.setAudioMuted(true);
      try {
        current = { id: document.id, html: composeDocument(document, request.styles, viewport) };
        try { await within(contents.loadURL(`${RENDER_SCHEME}://doc/${document.id}`), VIEW_MS); }
        catch (error) { result.errors.push({ viewport: viewport.name, code: error.code === 'RENDER_TIMEOUT' ? 'RENDER_TIMEOUT' : 'LOAD_FAILED' }); continue; }
        let facts;
        const options = { keys: request.probes.keys, properties: request.probes.properties, maxElements: request.probes.maxElements, bodyClasses: viewport.bodyClasses };
        try { facts = await within(contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${measure.toString()})(${JSON.stringify(options)})` }]), Math.max(1000, VIEW_MS - (Date.now() - started))); }
        catch (error) { result.errors.push({ viewport: viewport.name, code: error.code === 'RENDER_TIMEOUT' ? 'RENDER_TIMEOUT' : 'MEASURE_FAILED' }); continue; }
        let image = null;
        if (request.image && images.length < RENDER_LIMITS.images) {
          try {
            if (request.image.fullPage) window.setContentSize(viewport.width, Math.max(viewport.height, Math.min(RENDER_LIMITS.maxHeight, Math.ceil(facts.page.scrollHeight))));
            if (request.image.fullPage) await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))' }]);
            let picture = await contents.capturePage();
            const size = picture.getSize();
            const scale = Math.min(1, request.image.maxEdge / Math.max(size.width, size.height));
            if (scale < 1) picture = picture.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' });
            let jpeg = picture.toJPEG(request.image.quality);
            if (jpeg.length > RENDER_LIMITS.imageBytes) jpeg = picture.toJPEG(60);
            if (jpeg.length <= RENDER_LIMITS.imageBytes) {
              const final = picture.getSize();
              image = images.length;
              images.push({ document: document.id, viewport: viewport.name, mime: 'image/jpeg', width: final.width, height: final.height,
                sha256: createHash('sha256').update(jpeg).digest('hex'), base64: jpeg.toString('base64') });
            }
          } catch { result.errors.push({ viewport: viewport.name, code: 'IMAGE_FAILED' }); }
        }
        result.viewports.push({ name: viewport.name, width: viewport.width, height: viewport.height, ms: Date.now() - started, page: facts.page, fonts: facts.fonts,
          elements: facts.elements, truncated: facts.truncated, image });
      } finally { current = null; window.destroy(); }
    }
  }
  return { schema: FACTS_SCHEMA, engine: { name: 'electron', version: process.versions.electron ?? '', chromium: process.versions.chrome ?? '', protocol: RENDER_PROTOCOL },
    documents, images };
}

// The app side of screen.render that runs without Electron: the renderer the build writes in pack.json for both layouts
// (and the agent resolving it in the Windows layout), the page the worker serves (CSP first, the document's style sheets
// in order, the viewport's classes on <body>), and the worker branch of src/main/index.mjs before the single instance lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rendererFor, withRenderer } from '../../scripts/build.mjs';
import { verifyPack } from '../../src/main/core/pack-sync.mjs';
import { composeDocument, RENDER_CSP } from '../../src/main/render/document.mjs';
import { resolveRenderer } from '../../agent/lib/render.mjs';
import { readPack } from '../../agent/lib/agent.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));

test('build: pack.json names the app executable as the renderer on Windows and macOS', t => {
  assert.deepEqual(rendererFor('win', '44.9.2'), { kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe', electron: '44.9.2' });
  assert.deepEqual(rendererFor('mac', '44.9.2'), { kind: 'electron-worker', protocol: 1, path: '../../MacOS/SSAM Agent', electron: '44.9.2' });
  assert.deepEqual(rendererFor('win', null), { kind: 'electron-worker', protocol: 1, path: '../../SSAM Agent.exe' });
  // The Windows layout of an installation: <install>/resources/pack beside <install>/SSAM Agent.exe.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-build-renderer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = path.join(base, 'SSAM Agent'); const pack = path.join(install, 'resources', 'pack');
  fs.mkdirSync(path.join(pack, 'native'), { recursive: true });
  fs.writeFileSync(path.join(install, 'SSAM Agent.exe'), 'app');
  fs.writeFileSync(path.join(pack, 'native', 'ssam-agent.exe'), 'core');
  const files = [{ path: 'native/ssam-agent.exe', size: 4, sha256: createHash('sha256').update('core').digest('hex') }];
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ id: 'p', lanes: [], files }));
  const written = withRenderer(pack, 'win', '44.9.2');
  assert.deepEqual(written.renderer, rendererFor('win', '44.9.2'));
  assert.equal(verifyPack(pack).ok, true, verifyPack(pack).detail);
  const resolved = resolveRenderer({ runtimeRoot: pack, dataRoot: path.join(base, 'data'), pack: readPack(pack), platform: 'win32' });
  assert.equal(resolved.path, path.join(install, 'SSAM Agent.exe'));
  assert.equal(resolved.version, '44.9.2');
});

test('worker page: the CSP first, the style sheets in the order the document names them, the viewport classes on body', () => {
  const styles = [{ id: 'theme', css: '.t{}' }, { id: 'osui', css: '.o{}' }];
  const viewport = { name: 'tablet', width: 768, height: 1024, bodyClasses: ['tablet', 'portrait'] };
  const page = composeDocument({ id: 's1', html: '<!doctype html><html><head><title>x</title></head><body class="screen"><p>x</p></body></html>', styles: ['osui', 'theme'] }, styles, viewport);
  const head = page.indexOf('<head>') + '<head>'.length;
  assert.ok(page.startsWith('<meta http-equiv="Content-Security-Policy"', head), page);
  assert.ok(page.includes(RENDER_CSP));
  assert.ok(page.indexOf('data-ssam-style="osui"') < page.indexOf('data-ssam-style="theme"'));
  assert.ok(page.indexOf('data-ssam-style="theme"') < page.indexOf('<title>'));
  assert.match(page, /<body class="screen tablet portrait">/);
  assert.match(composeDocument({ id: 's1', html: '<html><body><p>x</p></body></html>', styles: [] }, styles, viewport), /<html><head><meta http-equiv="Content-Security-Policy"[^]*<body class="tablet portrait">/);
  assert.match(composeDocument({ id: 's1', html: '<p>x</p>', styles: [] }, styles, { ...viewport, bodyClasses: [] }), /^<!doctype html><head><meta http-equiv="Content-Security-Policy"/);
  assert.match(RENDER_CSP, /script-src 'none'/);
  assert.match(RENDER_CSP, /default-src 'none'/);
});

test('app: the render worker branches before the single instance lock and never starts the panel', () => {
  const source = fs.readFileSync(path.join(app, 'src', 'main', 'index.mjs'), 'utf8');
  const branch = source.indexOf('if (isRenderWorker()) void runRenderWorker();');
  assert.ok(branch > 0);
  assert.ok(branch < source.indexOf('app.requestSingleInstanceLock()'));
  assert.match(source, /else if \(!app\.requestSingleInstanceLock\(\)\) app\.quit\(\);\r?\nelse void run\(\);/);
});

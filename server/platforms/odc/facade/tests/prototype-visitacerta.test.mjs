// The VisitaCerta session of 2026-10-12 (docs/PROTOTIPO-NATIVO.md 1.2, 2.4, 2.9, 4.1): a ZIP whose root holds two pages
// ('Visita Certa.html', a name with a space, and a CSS showcase), the app's .jsx, the design tool's own panel and a screens/
// folder of reference images. Every call answered "The capture threw: The "path" argument must be of type string" (the
// Google Fonts <link> had no bundle file). Now: ONE refusal naming the entry the capture already tried, then the import.
import './fixtures/isolated-profile.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expandPrototypeOps, resolveSource } from '../prototype-op.mjs';
import { capturePrototype, closeResidentPools } from '../prototype/capture.mjs';
import { externalImport } from '../prototype/css-inventory.mjs';
import { translucentColor, paintFreeStyle } from '../prototype/dom-runtime.mjs';
import { rankEntries, pageScripts } from '../prototype/entry.mjs';
import { writeBundle } from '../prototype/bundle.mjs';
import { walk } from '../prototype/ir.mjs';
import { relocatePopups } from '../prototype/fidelity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'prototype', 'visita-certa');
const CLOCK = '2026-10-10T21:00:00Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-vc-'));
after(() => { closeResidentPools(); fs.rmSync(tmp, { recursive: true, force: true }); });
const calls = [];
const capture = args => { calls.push(args); return capturePrototype({ ...args, clock: CLOCK, pool: 4, vendorCache: path.join(tmp, 'no-cache'), download: null }); };
const all = root => { const out = []; walk(root, node => { out.push(node); if (node.list?.template) walk(node.list.template, inner => { out.push(inner); }); }); return out; };

// the files of the fixture, as the archive carries them (forward slashes, the screens/ folder included)
function fixtureEntries() {
  const out = [];
  const visit = (dir, prefix) => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) { out.push({ name: prefix + name + '/', data: Buffer.alloc(0) }); visit(file, prefix + name + '/'); } else out.push({ name: prefix + name, data: fs.readFileSync(file) }); } };
  visit(FIXTURE, '');
  return out;
}
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const raw = Buffer.from(entry.data);
    const method = entry.name.endsWith('/') ? 0 : 8; const body = method === 8 ? zlib.deflateRawSync(raw) : raw; const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(0x5b4c, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8); head.writeUInt16LE(method, 10); head.writeUInt16LE(0x5b4c, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test('visitacerta: two pages at the root refuse ONCE, the patch names the app page the capture already ran with; the corrected call reuses that capture', async () => {
  const work = path.join(tmp, 'local', 'prototype', 'w1');
  const job = { ops: [{ op: 'prototype', data: { source: FIXTURE, prefix: 'VisitaCerta', home: true, tz: 'America/Sao_Paulo' } }] };
  calls.length = 0;
  const first = await expandPrototypeOps(job, { work, capture });
  const r = first.refusal;
  assert.ok(r, 'a refusal');
  assert.equal(r.code, 'PROTOTYPE_SOURCE_INVALID');
  assert.equal(r.ssamDefect, undefined, 'never an SSAM defect');
  assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
  const [entry] = r.problems;
  assert.equal(entry.pointer, '/ops/0/data/entry');
  assert.deepEqual(entry.patch, [{ op: 'add', path: '/ops/0/data/entry', value: 'Visita Certa.html' }]);
  assert.deepEqual(entry.alternatives, ['visita-certa-css.html']);
  assert.equal(entry.verified, true, 'the capture ran with the page the patch names');
  assert.match(entry.message, /Visita Certa\.html loads 4 script\(s\) of the folder/);
  assert.match(entry.message, /visita-certa-css\.html has only inline script/);
  assert.match(entry.message, /2 screen\(s\), 1 popup\(s\)/);
  assert.equal(calls.length, 1); assert.equal(calls[0].entry, 'Visita Certa.html');
  assert.equal(job.ops[0].data.entry, undefined, 'the job given is never changed');
  assert.equal(r.correctedJob.ops[0].data.entry, 'Visita Certa.html');
  // the call with the patch applied: accepted, with the capture the refusal made (no second capture)
  const second = await expandPrototypeOps(r.correctedJob, { work: path.join(tmp, 'local', 'prototype', 'w2'), capture });
  assert.equal(second.refusal, undefined, JSON.stringify(second.refusal));
  assert.equal(second.captures[0].reused, true);
  assert.equal(calls.length, 1, 'captured once in the two calls');
  assert.ok(fs.existsSync(second.job.ops[0].data.capture));
});

test('visitacerta: the capture: the font <link> is an @import in the bundle, the body-mounted class-styled modal a popup, each row button its own trigger', async () => {
  const out = path.join(tmp, 'capture', 'bundle');
  const result = await capture({ source: FIXTURE, entry: 'Visita Certa.html', tz: 'America/Sao_Paulo', out });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const ir = result.ir;
  // the remote stylesheet: one statement in its own bundle file, never a sheet without one (the throw of the session)
  const external = ir.css.sheets.find(sheet => sheet.origin === 'external');
  assert.equal(external.url, 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;600&display=swap');
  assert.equal(fs.readFileSync(path.join(out, external.bundle), 'utf8'), '@import url("https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;600&display=swap");');
  assert.ok(ir.css.sheets.every(sheet => typeof sheet.bundle === 'string' && fs.existsSync(path.join(out, sheet.bundle))));
  // what the app is: the entry's scripts; the other page is listed; screens/ and the closed design panel are nothing
  assert.deepEqual(ir.source.files.map(file => file.path), ['Visita Certa.html', 'babel.min.js', 'tweaks-panel.jsx', 'vc-app.jsx', 'vc-ui.jsx']);
  assert.deepEqual(ir.source.unreferenced, ['visita-certa-css.html']);
  assert.deepEqual(ir.assets, []);
  let panel = 0; for (const tree of Object.values(ir.trees ?? {})) walk(tree, node => { if ((node.a ?? []).some(([name, value]) => name === 'class' && /twk-/.test(value))) panel++; });
  assert.equal(panel, 0, 'the design tool panel is never a screen element');
  // two screens (the toast a click leaves is no screen), the side menu is the shell, the weather modal a popup at the body level
  assert.deepEqual(ir.views.map(view => view.key), ['locais-salvos', 'cadastrar-local']);
  assert.ok(ir.shell);
  assert.deepEqual(ir.modals.map(modal => [modal.key, modal.name, modal.portal]), [['weather-peek-modal', 'WeatherPeekModal', true]]);
  const effects = Object.fromEntries(ir.events.map(event => [event.key, event.effects.map(effect => effect.kind + ':' + (effect.view ?? effect.modal ?? '')).join(',')]));
  assert.equal(effects['locais-salvos:click:btn-clima'], 'openPopup:weather-peek-modal');
  assert.equal(effects['locais-salvos:click:btn-agendar'], 'navigate:cadastrar-local');
  assert.ok('locais-salvos:click:btn-p0-0' in effects && 'locais-salvos:click:btn-p0-3' in effects, Object.keys(effects).join(', '));
  assert.equal(effects['shell:click:nav-item-cadastrar-local'], 'navigate:cadastrar-local');
  // a select without id is the control of its dimension; the space between an emoji and its label is kept
  const register = ir.views.find(view => view.key === 'cadastrar-local');
  assert.deepEqual(all(register.root).filter(node => node.control).map(node => [node.t, node.control.dimension]), [['select', 'select@2']]);
  const places = ir.views.find(view => view.key === 'locais-salvos');
  const seg = all(places.root).find(node => (node.a ?? []).some(([name, value]) => name === 'class' && value === 'seg'));
  assert.deepEqual(seg.c[1].c.map(text => text.x), ['📦', ' ', 'Entrega']);
  // the outlined and the filled star (the same path) are two icons; a style that paints nothing stays on the span
  const starNames = new Set(all(places.root).filter(node => node.icon && ir.icons.set[node.icon.name]?.svg.includes('m12 3 2.9')).map(node => node.icon.name));
  assert.equal(starNames.size, 2, 'outlined and filled');
  const icon = all(places.root).find(node => node.icon);
  assert.deepEqual(icon.icon.from.filter(([name]) => name === 'style'), [['style', 'width:18px;height:18px;flex-shrink: 0']]);
});

test('visitacerta: the ZIP (a name with a space, screens/ inside) gives the same one refusal, never an internal throw', async () => {
  const file = path.join(tmp, 'Visita Certa.zip');
  fs.writeFileSync(file, zip(fixtureEntries()));
  const resolved = resolveSource({ source: file }, { sourcesDir: path.join(tmp, 'zip', 'sources') });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.proposed.entry, 'Visita Certa.html');
  assert.equal(path.basename(resolved.proposed.root), resolved.proposed.archive.sha256);
  const r = (await expandPrototypeOps({ ops: [{ op: 'prototype', data: { source: file } }] }, { work: path.join(tmp, 'zip', 'prototype', 'w'), capture })).refusal;
  assert.equal(r.code, 'PROTOTYPE_SOURCE_INVALID');
  assert.deepEqual(r.problems.map(p => [p.pointer, p.verified]), [['/ops/0/data/entry', true]]);
  assert.ok(!r.problems.some(p => p.code === 'PROTOTYPE_IR_INVALID'));
});

test('units: the @import of a remote link, the backdrop colors, a paint-free style, the app page first, a bundle never throws', () => {
  assert.equal(externalImport('https://fonts.googleapis.com/css2?family=A&display=swap'), '@import url("https://fonts.googleapis.com/css2?family=A&display=swap");');
  assert.equal(externalImport('//cdn.example.com/x.css', 'print'), '@import url("//cdn.example.com/x.css") print;');
  assert.equal(externalImport('https://cdn.example.com/x.css', 'all'), '@import url("https://cdn.example.com/x.css");');
  assert.equal(externalImport('styles/missing.css'), null, 'a local file the page could not read styles nothing');
  assert.equal(externalImport('https://x.com/a.css', 'screen{}'), null);
  for (const color of ['oklch(15% 0.03 240 / .55)', 'rgba(0,0,0,0.5)', 'rgb(0 0 0 / 40%)', 'hsl(200 50% 40% / .3)', '#0008', '#00000080']) assert.equal(translucentColor(color), true, color);
  for (const color of ['oklch(15% 0.03 240)', 'rgb(1, 2, 3)', 'hsl(200, 50%, 40%)', 'transparent', '#000', 'rgba(0,0,0,0)', 'rgba(0,0,0,1)']) assert.equal(translucentColor(color), false, color);
  assert.equal(paintFreeStyle('flex-shrink: 0;'), true);
  assert.equal(paintFreeStyle('flex-shrink: 0; color: red'), false);
  assert.equal(paintFreeStyle('stroke-width: 2'), false);
  const ranked = rankEntries(FIXTURE, ['visita-certa-css.html', 'Visita Certa.html']);
  assert.deepEqual(ranked.map(item => item.page), ['Visita Certa.html', 'visita-certa-css.html']);
  assert.deepEqual(pageScripts('<script type="application/json">{}</script><script src="./a%20b.jsx" type="text/babel"></script><script src="https://x/y.js"></script><script>1</script>'), { local: ['a b.jsx'], remote: ['https://x/y.js'], inline: 1 });
  // the measure: a popup beside the shell instance is compared where its modal was among the body's children
  const proto = { t: 'body', c: [{ t: 'div', k: 's:app' }, { t: 'dialog', k: 'm:x' }, { t: 'div', k: 's:notifications' }] };
  const native = { t: 'body', c: [{ t: 'div', rt: 'IMobileBlockInstanceWidget', c: [{ t: 'div', k: 's:app' }, { t: 'div', k: 's:notifications' }] }, { t: 'div', rt: 'IPopup', c: [{ t: 'div', k: 'm:x' }] }] };
  assert.deepEqual(relocatePopups(native, proto).c.map(node => node.k ?? node.rt), ['s:app', 'IPopup', 's:notifications']);
  const dir = path.join(tmp, 'bundle-units');
  const written = writeBundle(dir, { schema: 'x' }, { sheets: [{ url: 'https://x/y.css' }, { bundle: 'sheets/a.css', text: 'a{}' }], assets: [{ path: 'img.png' }] });
  assert.ok(fs.existsSync(written)); assert.equal(fs.readFileSync(path.join(dir, 'sheets', 'a.css'), 'utf8'), 'a{}');
});

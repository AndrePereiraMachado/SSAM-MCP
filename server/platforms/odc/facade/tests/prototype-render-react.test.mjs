// A JSX/React prototype styled inline (docs/PROTOTIPO-NATIVO.md 2.2, 2.4, 2.7, 2.8), after the FolhaPonto session of
// 2026-10-12: text/babel scripts read statically, screens switched by state five levels down, a bottom sheet mounted by a
// click, classless buttons, a constant list as configuration, other versions in the folder. The fixture react-babel stands
// in for React and Babel (no CDN, no 3 MB vendor): its Babel is the identity with the inline source map the real one writes.
import './fixtures/isolated-profile.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePrototype, closeResidentPools } from '../prototype/capture.mjs';
import { siteOf, registerEvaluated, planScripts } from '../prototype/scripts.mjs';
import { triggerLabel } from '../prototype/dimensions.mjs';
import { deepenMount } from '../prototype/crawl.mjs';
import { repeatedGroups } from '../prototype/infer-lists.mjs';
import { walk } from '../prototype/ir.mjs';
import { trustedBabel, compileBabelSources } from '../prototype/babel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'prototype');
const clock = '2026-10-10T21:00:00Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-react-'));
after(() => { closeResidentPools(); fs.rmSync(tmp, { recursive: true, force: true }); });
const run = (options = {}) => capturePrototype({ source: path.join(fixtures, 'react-babel'), clock, pool: 4, vendorCache: path.join(tmp, 'no-cache'), download: null, ...options });
const all = root => { const out = []; walk(root, node => { out.push(node); if (node.list?.template) walk(node.list.template, inner => { out.push(inner); }); }); return out; };

test('react: a screen switched by state deep in a classless frame is a view per tab, the sheet a click mounts is a modal, the tabs navigate', async () => {
  const result = await run();
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const ir = result.ir;
  assert.equal(ir.kind, 'spa-state');
  assert.deepEqual(ir.views.map(view => [view.key, view.name, view.default]), [['bater', 'Bater', true], ['espelho', 'Espelho', false]]);
  // the mount is the screen, not the frame around it: the notch and the reset button are shell
  assert.ok(ir.shell, 'a shell');
  assert.ok(ir.shell.mount.path.length >= 2, JSON.stringify(ir.shell.mount));
  // the bottom sheet (translucent backdrop over the screen) is the modal DaySheet, named by the component that rendered it
  assert.deepEqual(ir.modals.map(modal => [modal.key, modal.name, modal.screens]), [['day-sheet', 'DaySheet', ['espelho']]]);
  const effects = Object.fromEntries(ir.events.map(event => [event.key, event.effects.map(effect => effect.kind + ':' + (effect.view ?? effect.modal ?? ''))]));
  assert.deepEqual(effects['bater:click:button-espelho'], ['navigate:espelho']);
  assert.deepEqual(effects['espelho:click:button-bater'], ['navigate:bater']);
  assert.deepEqual(effects['espelho:click:button'], ['openPopup:day-sheet'], 'the days of the calendar are one trigger (a list), never 12');
  assert.deepEqual(effects['day-sheet:click:button'], ['closePopup:']);
  // the icon-only reset button is named by its title, the call to action by its first words; none fused with another
  assert.ok(ir.events.some(event => event.key === 'shell:click:resetar-batidas'), Object.keys(effects).join(', '));
  assert.ok(ir.events.some(event => event.key === 'bater:click:button-bater-ponto-saida-almoco'), Object.keys(effects).join(', '));
});

test('react: the .jsx are read statically and named babel:<file>:<line>; the versions the entry never loads are listed', async () => {
  const result = await run();
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const ir = result.ir;
  assert.deepEqual(ir.source.files.map(file => file.path), ['babel.min.js', 'index.html', 'shared.jsx', 'v1-app.jsx']);
  assert.deepEqual(ir.source.unreferenced, ['v2-app.jsx']);
  assert.ok(ir.warnings.some(warning => warning.code === 'PrototypeIntervalSkipped' && warning.where === 'babel:v1-app.jsx:4'), JSON.stringify(ir.warnings));
  // the fixture's babel.min.js is a file of the prototype folder: prototype code never runs in the facade (the child renders)
  assert.ok(ir.warnings.some(warning => warning.code === 'PrototypeBabelUntrusted'), JSON.stringify(ir.warnings));
  // a constant list of the scripts is configuration: taken as a static collection and said so, with the alternative
  assert.equal(ir.store.source, 'config:window.STEPS');
  assert.deepEqual(ir.store.collections.map(collection => [collection.name, collection.mutated]), [['Steps', false]]);
  const said = ir.warnings.find(warning => warning.code === 'PrototypeStoreFromConfiguration');
  assert.match(said.lists[0].role, /constant list of 4 records/);
  assert.equal(said.alternatives[0].value, 'none');
});

test('react: siblings written differently are no list; a drawn svg of one color is an icon of its size and color', async () => {
  const result = await run();
  const bater = result.ir.views.find(view => view.key === 'bater');
  const lists = all(bater.root).filter(node => node.list);
  // the hero's label and clock, the two lines of the call to action, the signal and the battery: never lists
  assert.deepEqual(lists.map(node => node.list.collection), ['Steps'], JSON.stringify(lists.map(node => node.k)));
  const icons = all(bater.root).filter(node => node.icon);
  assert.equal(icons.length, 2);
  for (const icon of icons) {
    assert.match(icon.icon.name, /^svg-[0-9a-f]{8}$/);
    assert.match(icon.icon.from.find(([name]) => name === 'style')[1], /^width:\d+px;height:\d+px;color:#0f1a14$/);
  }
  const set = result.ir.icons.set[icons[0].icon.name];
  assert.match(set.svg, /fill="#000"/); assert.match(set.svg, /stroke="none"/);
});

test('react: mapping.version serves another version in place of the entry\'s app script; mapping.states names a view by its trigger', async () => {
  const v2 = await run({ mapping: { version: 'v2-app.jsx' } });
  assert.equal(v2.ok, true, JSON.stringify(v2.problems));
  assert.deepEqual(v2.ir.source.version, { from: 'v1-app.jsx', to: 'v2-app.jsx' });
  const texts = view => { const out = []; walk(view.root, node => { if (typeof node.x === 'string') out.push(node.x); }); return out.join(' '); };
  assert.match(texts(v2.ir.views.find(view => view.key === 'bater')), /Em jornada/);
  assert.ok(v2.ir.source.unreferenced.includes('v1-app.jsx'));
  const wrong = await run({ mapping: { version: 'v9.jsx' } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.problems[0].path, '/ops/0/data/mapping/version');
  assert.deepEqual(wrong.problems[0].alternatives, ['v2-app.jsx']);
  // a view named by mapping.states: the click on the words of its trigger
  const mapped = await run({ mapping: { states: { calendario: { click: 'Espelho' } } } });
  assert.equal(mapped.ok, true, JSON.stringify(mapped.problems));
  assert.deepEqual(mapped.ir.views.map(view => view.key), ['inicio', 'calendario']);
  const missing = await run({ mapping: { states: { nada: { click: 'Não existe' } } } });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].path, '/ops/0/data/mapping/states/nada');
  // mapping.data "none": no store, the steps stay as rendered
  const none = await run({ mapping: { data: 'none' } });
  assert.equal(none.ok, true, JSON.stringify(none.problems));
  assert.equal(none.ir.store.collections.length, 0);
});

test('units: stack sites with spaces, the line map of evaluated code, trigger words, the deep mount, heterogeneous pairs', () => {
  assert.deepEqual(siteOf('Error\n    at fit (http://prototype.ssam/Folha de Ponto.html:46:10)'), { file: 'http://prototype.ssam/Folha de Ponto.html', line: 46, column: 10 });
  assert.deepEqual(siteOf('Error\n    at Folha de Ponto.html:12:3'), { file: 'Folha de Ponto.html', line: 12, column: 3 });
  // a script Babel evaluated: named by its source map, its lines mapped back (generated line 1 -> source line 7, line 3 -> line 9)
  const map = { version: 3, sources: ['http://prototype.ssam/app.jsx'], mappings: 'AAMA;;AAEA' };
  const name = registerEvaluated('x\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
  assert.equal(name, 'babel:app.jsx');
  assert.deepEqual(siteOf('Error\n    at f (babel:app.jsx:3:1)'), { file: 'babel:app.jsx', line: 9, column: 1 });
  const inline = registerEvaluated('y\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({ version: 3, sources: ['Inline Babel script'], mappings: 'AAAA' })).toString('base64'), { entry: 'Folha de Ponto.html', inline: [42] });
  assert.equal(inline, 'babel:Folha de Ponto.html');
  assert.equal(siteOf('Error\n    at g (babel:Folha de Ponto.html:1:1)').line, 42);
  // text/babel is source code: kind babel in the plan
  const doc = { URL: 'http://prototype.ssam/index.html', querySelectorAll: () => [{ getAttribute: name => ({ type: 'text/babel', src: 'a.jsx' })[name] ?? null, hasAttribute: () => false }] };
  assert.equal(planScripts(doc)[0].kind, 'babel');
  // the static compile of the .jsx: only the @babel/standalone package (or a pinned build) runs in the facade
  const fake = fs.readFileSync(path.join(fixtures, 'react-babel', 'babel.min.js'), 'utf8');
  const official = { url: 'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js', from: 'cache', text: fake };
  assert.equal(trustedBabel(official), true);
  assert.equal(trustedBabel({ ...official, from: 'folder' }), false, 'a copy in the prototype folder is vouched only by a pinned sha256');
  assert.equal(trustedBabel({ ...official, url: 'https://unpkg.com/evil@1.0.0/babel.min.js' }), false);
  assert.equal(trustedBabel({ url: null, from: 'local', text: fake }), false);
  const compiled = compileBabelSources(official, [{ file: 'a.jsx', text: 'var x = 1;' }, { file: 'Page.html', text: 'var y = 2;', line: 5 }]);
  assert.deepEqual(compiled.sources.map(item => [item.file, item.text.split('\n').length]), [['babel:a.jsx', 1], ['babel:Page.html', 5]]);
  assert.equal(compileBabelSources({ url: null, from: 'local', text: fake }, [{ file: 'a.jsx', text: '' }]).warnings[0].code, 'PrototypeBabelUntrusted');
  // trigger words: own text (four words at most), else title, else aria-label
  assert.equal(triggerLabel({ t: 'button', c: [{ t: 'div', c: [{ x: 'Bater ponto' }] }, { t: 'div', c: [{ x: 'Saída almoço previsto 12:00' }] }] }), 'bater-ponto-saida-almoco');
  assert.equal(triggerLabel({ t: 'button', a: [['title', 'Resetar batidas']], c: [{ x: '↺' }] }), 'resetar-batidas');
  // the deep mount: down the frame while exactly one child differs
  const page = screen => ({ t: 'body', c: [{ t: 'div', c: [{ t: 'div', c: [{ t: 'div', a: [['n', '1']] }, { t: 'div', c: screen }, { t: 'button', c: [{ x: 'r' }] }] }] }] });
  assert.deepEqual(deepenMount([page([{ t: 'p', c: [{ x: 'a' }] }]), page([{ t: 'ul', c: [] }, { t: 'p', c: [] }])], [0]), [0, 0, 1]);
  // a pair of classless siblings styled differently is no list; the same style is
  const pair = (a, b) => repeatedGroups({ t: 'div', c: [{ t: 'div', a: [['style', a]], c: [{ x: '1' }] }, { t: 'div', a: [['style', b]], c: [{ x: '2' }] }] });
  assert.equal(pair('font-size: 12px;', 'font-size: 86px;').length, 0);
  assert.equal(pair('font-size: 12px;', 'font-size: 12px;').length, 1);
});

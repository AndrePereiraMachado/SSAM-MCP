// Prototype capture over the other prototype shapes (docs/PROTOTIPO-NATIVO.md 7.1 tests 9, 10 and 11).
import './fixtures/isolated-profile.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePrototype, closeResidentPools } from '../prototype/capture.mjs';
import { openPage } from '../prototype/dom-runtime.mjs';
import { ScriptCache } from '../prototype/scripts.mjs';
import { SourceFiles } from '../prototype/network.mjs';
import { walk } from '../prototype/ir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'prototype');
const vendorCache = path.join(fixtures, 'cdn', 'vendor-cache');
const clock = '2026-10-10T21:00:00Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-fx-'));
after(() => { closeResidentPools(); fs.rmSync(tmp, { recursive: true, force: true }); });

const run = (name, options = {}) => capturePrototype({ source: path.join(fixtures, name), clock, pool: 4, vendorCache, download: null, ...options });
const all = root => { const out = []; walk(root, node => { out.push(node); if (node.list?.template) walk(node.list.template, inner => { out.push(inner); }); }); return out; };

function applyPatch(document, patch) {
  const copy = JSON.parse(JSON.stringify(document));
  for (const operation of patch) {
    assert.equal(operation.op, 'add');
    const keys = operation.path.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys[keys.length - 1]] = operation.value;
  }
  return copy;
}

test('9a. a script from a host outside the CDN allowlist refuses with the mapping.vendor patch', async () => {
  const result = await run('external-script');
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  const [problem] = result.problems;
  assert.equal(problem.code, 'PROTOTYPE_RENDER_FAILED');
  assert.equal(problem.path, '/ops/0/data/mapping/vendor/https:~1~1example.com~1widgets~1weather.js');
  assert.match(problem.message, /outside the CDN allowlist/);
  assert.equal(problem.patch[0].path, '/ops/0/data/mapping');
  assert.deepEqual(Object.keys(problem.patch[0].value.vendor), ['https://example.com/widgets/weather.js']);
  const suggested = problem.patch[0].value.vendor['https://example.com/widgets/weather.js'];
  assert.deepEqual([path.basename(path.dirname(suggested)), path.basename(suggested)], ['vendor', 'weather.js']);
  const withMapping = await run('external-script', { mapping: { ignore: ['#debug'] } });
  assert.equal(withMapping.problems[0].patch[0].path, '/ops/0/data/mapping/vendor');
});

test('9b. an allowlisted CDN script without cache and without network refuses; with the fixture cache it captures', async () => {
  const offline = await run('cdn', { vendorCache: path.join(tmp, 'empty-cache') });
  assert.equal(offline.ok, false);
  assert.equal(offline.problems[0].code, 'PROTOTYPE_RENDER_FAILED');
  assert.match(offline.problems[0].message, /not in the vendor cache/);
  const cached = await run('cdn');
  assert.equal(cached.ok, true, JSON.stringify(cached.problems));
  assert.deepEqual(cached.ir.source.vendor, [{ url: 'https://unpkg.com/tiny-board@1.0.0/dist/tiny-board.js', sha256: '7d43d9d8ef8a7e30b530c8106d2855c1c41886f4d358cbabe7070171a2f5e77f' }]);
  const items = all(cached.ir.views[0].root).filter(node => node.t === 'li');
  assert.ok(items.length >= 1, 'the library rendered the board');
});

test('9c. a local JSON read by fetch is the store; a foreign fetch is blocked and reported', async () => {
  const result = await run('fetch-json');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.store.source, 'file:data/books.json');
  assert.equal(result.ir.store.collections[0].name, 'Book');
  assert.ok(result.ir.warnings.some(item => item.code === 'PrototypeNetworkBlocked' && item.url === 'https://api.example.com/stats'), JSON.stringify(result.ir.warnings));
  assert.ok(result.ir.source.files.some(file => file.path === 'data/books.json'));
});

test('9d. no request reaches the global dispatcher: subresources hit the rejecting dispatcher, fetch/XHR are local only', async () => {
  const dir = path.join(tmp, 'net');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body><iframe src="https://example.com/frame"></iframe><p id="out">x</p></body></html>');
  fs.writeFileSync(path.join(dir, 'local.json'), '{"ok":true}');
  const symbol = Symbol.for('undici.globalDispatcher.1');
  const previous = globalThis[symbol];
  const calls = [];
  globalThis[symbol] = { dispatch(options) { calls.push(options); return false; }, close() {}, destroy() {}, compose() { return this; } };
  try {
    const files = new SourceFiles(dir);
    const page = await openPage({ html: files.text('index.html'), entry: 'index.html', files, cache: new ScriptCache(), vendors: new Map(), clock: Date.parse(clock), seed: 1, storage: null, mapping: {}, ruleCache: new Map() });
    const local = await page.window.fetch('local.json').then(response => response.json());
    assert.deepEqual(local, { ok: true });
    await assert.rejects(page.window.fetch('https://api.example.com/data'));
    const xhr = new page.window.XMLHttpRequest();
    xhr.open('GET', 'local.json', false);
    xhr.send();
    assert.equal(xhr.status, 200);
    const foreign = new page.window.XMLHttpRequest();
    foreign.open('GET', 'https://api.example.com/x', false);
    foreign.send();
    assert.equal(foreign.status, 0);
    assert.throws(() => new page.window.WebSocket('wss://example.com'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls.length, 0, 'the global dispatcher was used');
    assert.ok(page.dispatcher.rejected.some(url => url.startsWith('https://')), JSON.stringify(page.dispatcher.rejected));
    assert.ok(page.log.warnings.some(item => item.code === 'PrototypeNetworkBlocked' && item.kind === 'fetch'));
    page.close();
  } finally {
    globalThis[symbol] = previous;
  }
});

test('10. ambiguous: one refusal with every problem and its patch; the patches together capture cleanly', async () => {
  const result = await run('ambiguous');
  assert.equal(result.ok, false);
  const byPath = Object.fromEntries(result.problems.map(problem => [problem.path, problem]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/ops/0/data/mapping/data', '/ops/0/data/mapping/states']);
  for (const problem of result.problems) assert.equal(problem.code, 'PROTOTYPE_AMBIGUOUS');
  assert.match(byPath['/ops/0/data/mapping/states'].message, /relatorio/);
  assert.match(byPath['/ops/0/data/mapping/states'].message, /Acesso nao disponivel/);
  assert.deepEqual(byPath['/ops/0/data/mapping/data'].alternatives, ['window.DATA']);
  const patches = result.problems.flatMap(problem => problem.patch);
  const job = applyPatch({ ops: [{ op: 'prototype', data: { source: path.join(fixtures, 'ambiguous') } }] }, patches);
  assert.deepEqual(job.ops[0].data.mapping, { states: { relatorio: { perfil: 'admin' } }, data: 'Store.initial()' });
  const fixed = await run('ambiguous', { mapping: job.ops[0].data.mapping });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.problems));
  assert.deepEqual(fixed.ir.views.map(view => view.key).sort(), ['obras', 'relatorio']);
  assert.deepEqual(fixed.ir.views.find(view => view.key === 'relatorio').state, { perfil: 'admin' });
  assert.equal(fixed.ir.store.source, 'mapping:Store.initial()');
  const list = all(fixed.ir.views.find(view => view.key === 'obras').root).find(node => node.list);
  assert.equal(list.list.collection, 'Obra');
});

test('10b. two modals with the same title and different structures refuse with the modals patch; named, they are two popups', async () => {
  const result = await run('modal-ambiguous');
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1, JSON.stringify(result.problems));
  const [problem] = result.problems;
  assert.equal(problem.code, 'PROTOTYPE_AMBIGUOUS');
  assert.equal(problem.path, '/ops/0/data/mapping/modals');
  assert.match(problem.message, /"Detalhes"/);
  const job = applyPatch({ ops: [{ op: 'prototype', data: { source: path.join(fixtures, 'modal-ambiguous') } }] }, problem.patch);
  assert.deepEqual(job.ops[0].data.mapping, { modals: { detalhes: 'Detalhes', 'detalhes-2': 'Detalhes2' } });
  const fixed = await run('modal-ambiguous', { mapping: { modals: { detalhes: 'DetalhesServico', 'detalhes-2': 'DetalhesCliente' } } });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.problems));
  assert.equal(fixed.ir.kind, 'static', 'opening a dialog is a modal, never a spa-state view');
  assert.deepEqual(fixed.ir.modals.map(modal => [modal.key, modal.name]), [['detalhes', 'DetalhesServico'], ['detalhes-2', 'DetalhesCliente']]);
  const opens = Object.fromEntries(fixed.ir.events.filter(event => event.effects[0]?.kind === 'openPopup').map(event => [event.key, event.effects[0].modal]));
  assert.deepEqual(opens, { 'index:click:ver-servico': 'detalhes', 'index:click:ver-cliente': 'detalhes-2' });
});

test('11a. multi-page: every linked page is a view; the shared header and footer are the shell; links navigate', async () => {
  const result = await run('multipage');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'multi-page');
  assert.deepEqual(result.ir.views.map(view => view.key), ['index', 'servicos', 'contato']);
  assert.deepEqual(result.ir.shell.regionInfo.map(item => item.name), ['topo', 'rodape']);
  const links = all(result.ir.views[0].root).filter(node => node.nav);
  assert.ok(links.some(node => node.nav.view === 'servicos'), JSON.stringify(links.map(node => node.nav)));
  const sheets = Object.fromEntries(result.ir.css.sheets.map(sheet => [sheet.path, sheet.page]));
  assert.deepEqual(sheets, { 'site.css': null, 'contato.css': 'page:contato' }, 'a sheet of one page only goes to that screen');
  const services = all(result.ir.views.find(view => view.key === 'servicos').root).find(node => node.list);
  assert.equal(services.list.collection, null, 'no store: the repeated group is a snapshot list');
  assert.deepEqual(services.list.snapshot, { entity: 'ClinicaAuroraServicosServicos', attributes: [{ name: 'H2', type: 'Text' }, { name: 'P', type: 'Text' }], rows: [{ H2: 'Consulta geral', P: 'Atendimento clinico.' }, { H2: 'Exames', P: 'Coleta no local.' }, { H2: 'Vacinas', P: 'Calendario completo.' }] });
  assert.deepEqual(services.list.template.c[0].c[0].expr.value, { field: 'H2' });
  const menu = all(result.ir.views[0].root).filter(node => node.list);
  assert.equal(menu.length, 0, 'navigation links never become a snapshot list');
});

test('11b. spa-sections: each section is a view; the tabs navigate to their section', async () => {
  const result = await run('sections');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'spa-sections');
  assert.deepEqual(result.ir.views.map(view => view.key), ['overview', 'vehicles', 'drivers']);
  assert.equal(result.ir.views.find(view => view.default).key, 'overview');
  for (const key of ['vehicles', 'drivers']) {
    const event = result.ir.events.find(item => item.key === 'shell:click:' + key);
    assert.deepEqual(event?.effects, [{ kind: 'navigate', view: key, params: {} }], key);
  }
  const tabs = all(result.ir.shell.root).filter(node => node.nav);
  assert.deepEqual(tabs.map(node => node.nav.view), ['overview', 'vehicles', 'drivers']);
});

test('11h. routed sections (the owner\'s Morada): fixed section.view[data-view] shown by a hash router, the empty hash on its default route, a data object of several collections, dialogs reached after the login dialog; no mapping', async () => {
  const result = await run('morada');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const ir = result.ir;
  assert.equal(ir.kind, 'spa-hash');
  assert.deepEqual(ir.views.map(view => view.name), ['Buscar', 'Imovel', 'Favoritos', 'Propostas', 'Anunciar', 'Painel']);
  assert.equal(ir.views.find(view => view.default)?.key, 'buscar', 'the empty hash shows the router\'s default section');
  assert.ok(ir.views.every(view => view.keepRoot), 'each screen is its own section');
  assert.equal(ir.views.find(view => view.key === 'imovel').params[0]?.type, 'Integer');
  // the shell: the top bar and the footer around main, the mount (no section of it)
  assert.ok(ir.shell, 'a shell');
  assert.ok(ir.shell.regionInfo.some(info => info.role === 'mount' && info.name === 'main'), JSON.stringify(ir.shell.regionInfo));
  // the five dialogs are popups of the screens that open them
  const byId = Object.fromEntries(ir.modals.map(modal => [modal.container.attrs.find(([name]) => name === 'id')[1], [...modal.screens].sort()]));
  assert.deepEqual(Object.keys(byId).sort(), ['dlg-confirmar', 'dlg-editar', 'dlg-login', 'dlg-proposta', 'dlg-visita']);
  assert.deepEqual(byId['dlg-visita'], ['imovel']);
  assert.deepEqual(byId['dlg-proposta'], ['imovel']);
  assert.deepEqual(byId['dlg-editar'], ['painel']);
  assert.deepEqual(byId['dlg-confirmar'], ['painel', 'propostas']);
  // the store is the data object; each rendered list reads its own collection
  assert.equal(ir.store.source, 'global:MoradaData');
  assert.deepEqual(ir.store.collections.map(collection => collection.name).sort(), ['favoritos', 'imoveis', 'imoveisFotos', 'propostas', 'usuarios']);
  const listsOf = view => all(ir.views.find(item => item.key === view).root).filter(node => node.list?.collection).map(node => node.list);
  assert.deepEqual(listsOf('buscar').map(list => list.collection), ['imoveis']);
  // the favorites are the members of the Set, shown through their property (never a range of rents that happens to fit)
  assert.deepEqual(listsOf('favoritos').map(list => list.collection), ['favoritos']);
  // the tables a map() fills are lists of their own collection, filtered by the session when the render filters
  assert.deepEqual(listsOf('propostas').map(list => [list.collection, list.filter]), [['propostas', { op: 'eq', l: { field: 'InquilinoId' }, r: { dim: 'login-usuario' } }]]);
  assert.deepEqual(listsOf('painel').map(list => [list.collection, list.filter]), [
    ['imoveis', { op: 'eq', l: { field: 'ProprietarioId' }, r: { dim: 'login-usuario' } }],
    ['propostas', { op: 'eq', l: { field: 'ProprietarioId', via: 'ImovelId' }, r: { dim: 'login-usuario' } }]]);
  // the model's fields in PascalCase
  assert.deepEqual(ir.store.collections.find(collection => collection.name === 'propostas').fields.map(field => field.name).slice(0, 3), ['Id', 'ImovelId', 'InquilinoId']);
  // the account chosen in the login dialog is a session dimension, the state the owner's screens were explored in; the cover
  // photo of the listing form is a field of that form, never a global dimension
  assert.ok(ir.dimensions.some(dim => dim.key === 'login-usuario' && dim.kind === 'dialog' && dim.scope === 'global'));
  assert.ok(!ir.dimensions.some(dim => dim.scope === 'global' && dim.key !== 'login-usuario'), JSON.stringify(ir.dimensions.map(dim => dim.key + ':' + dim.scope)));
  assert.ok(ir.events.some(event => event.key === 'painel:click:toggle-status' && event.effects.some(effect => effect.kind === 'update' && effect.collection === 'imoveis')));
  // the favorite button of a list row: one membership toggle by the row's key; the search form: its selects are view
  // dimensions it sets (the list filters by them)
  const toggle = ir.events.find(event => event.key === 'buscar:click:toggle-fav');
  assert.equal(toggle.compiled, true);
  assert.deepEqual(toggle.effects.filter(effect => effect.kind === 'toggle'), [{ kind: 'toggle', collection: 'favoritos', keys: { ImovelId: { param: 'Id' } } }]);
  const filter = ir.events.find(event => event.key === 'buscar:submit:filtros');
  assert.equal(filter.compiled, true);
  assert.deepEqual(filter.effects.map(effect => effect.dimension), ['f-cidade', 'f-tipo', 'f-quartos']);
  // a row text of several fields is one concat of them; a count says its noun in the singular for 1; no attribute is made up
  // from a class name for what the fields explain (what no field explains stays an attribute named by its words, or by the
  // title of its table column: the computed total, the count of proposals of a listing)
  const row = JSON.stringify(listsOf('buscar')[0].template);
  assert.ok(all(listsOf('buscar')[0].template).some(node => node.expr?.fmt === 'concat' && node.expr.parts.map(part => part.value.field).join() === 'Bairro,Cidade,Tipo'), row.slice(0, 400));
  assert.ok(all(listsOf('buscar')[0].template).some(node => node.expr?.plural && node.expr.else.suffix === ' vagas'));
  assert.deepEqual(ir.extraAttributes.filter(item => item.collection === 'imoveis').map(item => item.name).sort(), ['Propostas', 'Total']);
  // the status of a proposal is read from its field over every session's rows (a status one session never shows included)
  assert.ok(JSON.stringify(listsOf('propostas')[0].template).includes('"field":"Status"'));
  // the options of a static select keep the order the page shows them
  const tipo = all(ir.views.find(view => view.key === 'anunciar').root).find(node => node.t === 'select' && node.a?.some(([name, value]) => name === 'name' && value === 'tipo'));
  assert.deepEqual((tipo.options?.rows ?? []).map(option => option.Label), ['Apartamento', 'Casa', 'Studio', 'Kitnet']);
});

test('11c. static: one view, the whole page, its image an asset of the bundle', async () => {
  const result = await run('static');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'static');
  assert.equal(result.ir.views.length, 1);
  assert.deepEqual(result.ir.assets.map(asset => [asset.path, asset.uses]), [['harbor.svg', ['css', 'img']]]);
  assert.equal(result.ir.events.length, 0);
});

test('11d. ES modules with an import map: hash views, the module store and its event', async () => {
  const result = await run('esm');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'spa-hash');
  assert.deepEqual(result.ir.views.map(view => view.template), ['recipes', 'recipe/{id}']);
  assert.equal(result.ir.store.source, 'global:RecipeData.seed()');
  const favorite = result.ir.events.find(event => event.key === 'recipes:click:favorite');
  assert.deepEqual(favorite.effects, [{ kind: 'toggle', collection: 'Recipe', field: 'Favorite', key: { param: 'Id' } }]);
  assert.ok(result.ir.source.files.some(file => file.path === 'lib/store.mjs'));
});

test('11e. spa-path: pushState routes are views; path anchors navigate', async () => {
  const result = await run('path-router');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'spa-path');
  assert.deepEqual(result.ir.views.map(view => view.template).sort(), ['/', '/about', '/work']);
  const links = all(result.ir.shell.root).filter(node => node.nav);
  assert.deepEqual(links.map(node => node.nav.view).sort(), result.ir.views.map(view => view.key).sort());
});

test('11f. spa-state: views by skeleton (not dimensions); the buttons navigate between them', async () => {
  const result = await run('state-machine');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'spa-state');
  assert.deepEqual(result.ir.views.map(view => view.name), ['Welcome', 'ChooseAPlan', 'AllSet']);
  const nav = Object.fromEntries(result.ir.events.filter(event => event.effects[0].kind === 'navigate').map(event => [event.key, event.effects[0].view]));
  assert.deepEqual(nav, { 'welcome:click:start': 'choose-a-plan', 'choose-a-plan:click:finish': 'all-set', 'all-set:click:restart': 'welcome' });
  const option = result.ir.events.find(event => event.key === 'choose-a-plan:click:option');
  assert.equal(option.effects[0].kind, 'setDimension', 'the plan buttons only change a dimension, never a view');
});

test('11g. react-like: targets found through __reactProps$ (no attribute marks them), views by skeleton, record parameters', async () => {
  const result = await run('react-like');
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.ir.kind, 'spa-state');
  assert.deepEqual(result.ir.views.map(view => view.key), ['shop', 'cart']);
  // the tab bar only moves its active tab between the views: it is the frame (shell), the section under it the screen
  // (crawl.mjs deepens the mount as for screen switches; VisitaCerta 2026-10-12, its side menu)
  const nav = Object.fromEntries(result.ir.events.filter(event => event.effects[0].kind === 'navigate').map(event => [event.key, event.effects[0].view]));
  assert.deepEqual(nav, { 'shell:click:tab-cart': 'cart', 'shell:click:tab-shop': 'shop' });
  assert.ok(result.ir.shell, 'the tab bar is the shell');
  const add = result.ir.events.find(event => event.key === 'shop:click:add');
  assert.deepEqual(add.params, [{ name: 'Id', from: 'record', type: 'Integer' }]);
  assert.deepEqual(add.effects, [{ kind: 'increment', collection: 'Item', field: 'Qty', key: { param: 'Id' }, by: { lit: 1 } }]);
});

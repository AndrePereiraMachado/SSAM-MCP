// Rules of the render lane (docs/PROTOTIPO-NATIVO.md 2.1-2.11), one test per rule over the pure modules: formats,
// predicates, annotations, names, IR, CSS inventory, script literals, vendor cache, network, perturbation, patches.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explainGroup, explainSlots, explainConcat, explainCount, formatValue } from '../prototype/formats.mjs';
import { separate, decisionList, evaluate } from '../prototype/predicates.mjs';
import { annotateRegion, fieldVars, listTemplate, snapshotTemplate } from '../prototype/infer-lists.mjs';
import { pascal, modalSlug, prefixFrom, recordInputName, aggregateInputName, readmeRoutes, uniqueName } from '../prototype/names.mjs';
import { canonical, irHash, treeHash, validateIr, SCHEMA } from '../prototype/ir.mjs';
import { cssImports, cssUrls, localReference } from '../prototype/css-inventory.mjs';
import { analyzeScripts } from '../prototype/scripts.mjs';
import { resolveVendors, storeInCache, suggestedVendorPath } from '../prototype/vendor.mjs';
import { localPath } from '../prototype/network.mjs';
import { toggledSections, uniqueSelector, matchesSelector, visibleBody, hiddenAt } from '../prototype/crawl.mjs';
import { recordCollections, singularOf, typeCollections } from '../prototype/store.mjs';
import { mappingWith, pascalFields, membershipToggle } from '../prototype/capture.mjs';
import { sentinel, invalidValues, searchWords } from '../prototype/perturb.mjs';
import { mappingPatches } from '../prototype/capture.mjs';
import { specificity } from '../prototype/dom-runtime.mjs';
import { StoreMeta } from '../prototype/effects.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-rules-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const text = x => ({ x });
const el = (t, a = [], c = []) => ({ t, a, c });
const has = (value, needle) => JSON.stringify(value).includes(needle);

// ---- formats (2.8 table) ----------------------------------------------------------------------------------------------

test('format: a number never sits next to a digit or letter of its literal (pad:3:0, not integer after "#00")', () => {
  assert.deepEqual(explainGroup(['Produto #001'], [1], { locale: 'pt-BR' }), { fmt: 'pad:3:0', prefix: 'Produto #', suffix: '' });
  assert.equal(explainGroup(['Adicionar'], ['a'], { locale: 'pt-BR' }), null, 'a core inside a word is no explanation');
});

test('format: currency keeps the exact Intl separator (U+00A0) and the decimal separator of the locale', () => {
  assert.equal(formatValue('currency:pt-BR:BRL', 49.9), 'R$\u00a049,90');
  assert.deepEqual(explainGroup(['R$\u00a049,90'], [49.9], { locale: 'pt-BR' }), { fmt: 'currency:pt-BR:BRL', prefix: '', suffix: '' });
});

test('format: substr-after/substr-before need a structural separator present in >= 2 correlated rows', () => {
  assert.deepEqual(explainSlots(['product-photo tile-3', 'product-photo tile-5'], ['assets/products.png#tile=3', 'assets/products.png#tile=5'], { locale: 'pt-BR' }), { fmt: 'substr-after:#tile=', prefix: 'product-photo tile-', suffix: '' });
  assert.equal(explainSlots(['maria', 'joao'], ['maria@x.com', 'joao@y.com'], { locale: 'pt-BR' }).fmt, 'substr-before:@');
  assert.equal(explainSlots(['tile-3'], ['assets/products.png#tile=3'], { locale: 'pt-BR' }), null, 'one row is not enough');
  assert.equal(explainSlots(['ab', 'cd'], ['xab', 'ycd'], { locale: 'pt-BR' }), null, 'no structural separator');
});

// ---- predicates (2.8 grammar) -----------------------------------------------------------------------------------------

const row = (values, dims = {}) => ({ row: values, dims });

test('predicate: the grammar order picks f > 0 for a stock field', () => {
  const vars = { fields: [{ name: 'Estoque', type: 'Integer' }] };
  assert.deepEqual(separate(vars, [row({ Estoque: 3 }), row({ Estoque: 5 })], [row({ Estoque: 0 })]), { op: 'gt', l: { field: 'Estoque' }, r: { lit: 0 } });
});

test('predicate: a free-text dimension is compared with its empty value, never with the probe word', () => {
  const positives = [{ dims: { q: 'zzzz-ssam' } }], negatives = [{ dims: { q: '' } }];
  assert.deepEqual(separate({ dims: [{ key: 'q', zero: '', free: true }] }, positives, negatives), { op: 'ne', l: { dim: 'q' }, r: { lit: '' } });
  assert.deepEqual(separate({ dims: [{ key: 'q', zero: '' }] }, positives, negatives), { op: 'eq', l: { dim: 'q' }, r: { lit: 'zzzz-ssam' } }, 'without the free mark the literal wins (the rule matters)');
});

test('predicate: a hidden dimension set to several values is D <> zero', () => {
  const vars = { dims: [{ key: 'successId', zero: '0', hidden: true }] };
  assert.deepEqual(separate(vars, [{ dims: { successId: '1005' } }, { dims: { successId: '1006' } }], [{ dims: { successId: '0' } }]), { op: 'ne', l: { dim: 'successId' }, r: { lit: '0' } });
});

test('predicate: a range of one value is an equality (f <= k and f >= k -> f = k)', () => {
  const vars = { fields: [{ name: 'Order', type: 'Integer' }] };
  assert.deepEqual(separate(vars, [row({ Order: 2 })], [row({ Order: 1 }), row({ Order: 3 })]), { op: 'eq', l: { field: 'Order' }, r: { lit: 2 } });
});

test('predicate: ties go to the variables that already govern the node (vars.prefer), then the grammar order', () => {
  const fields = [{ name: 'CategoriaId', type: 'Integer', lowCardinality: true }, { name: 'Estoque', type: 'Integer' }];
  const positives = [row({ CategoriaId: 3, Estoque: 5 })], negatives = [row({ CategoriaId: 1, Estoque: 0 })];
  assert.deepEqual(separate({ fields }, positives, negatives), { op: 'eq', l: { field: 'CategoriaId' }, r: { lit: 3 } });
  assert.deepEqual(separate({ fields, prefer: ['{"field":"Estoque"}'] }, positives, negatives), { op: 'gt', l: { field: 'Estoque' }, r: { lit: 0 } });
});

test('predicate: decision lists take the simplest separating group first; the last group is the else', () => {
  const vars = { fields: [{ name: 'Estoque', type: 'Integer' }] };
  const groups = [{ name: 'out', contexts: [row({ Estoque: 0 })] }, { name: 'low', contexts: [row({ Estoque: 3 }), row({ Estoque: 8 })] }, { name: 'ok', contexts: [row({ Estoque: 24 }), row({ Estoque: 40 })] }];
  const decision = decisionList(vars, groups);
  assert.deepEqual(decision.map(item => item.group.name), ['out', 'low', 'ok']);
  assert.equal(decision[2].when, null);
  assert.equal(evaluate(decision[1].when, row({ Estoque: 8 })), true);
});

test('predicate: a Text field is a variable only when categorical (a role code), never a name', () => {
  const meta = new StoreMeta({ Users: [{ Id: 1, Name: 'Marina Costa', Role: 'Cliente' }, { Id: 2, Name: 'Lucas Oliveira', Role: 'Cliente' }, { Id: 3, Name: 'Rafael Lima', Role: 'Admin' }] });
  const names = fieldVars(meta, 'Users', meta.byName.get('Users').rows).map(field => field.name);
  assert.deepEqual(names, ['Role']);
});

// ---- annotations (2.8 "variantes") ------------------------------------------------------------------------------------

test('annotation: a computed class token (tile-N) is a source with a format, not one predicate per token', () => {
  const trees = [3, 5, 1].map(n => el('div', [['class', 'product-photo tile-' + n]]));
  const contexts = [1, 2, 3].map(id => row({ CategoriaId: id }));
  const sources = [3, 5, 1].map(n => ({ 'record:Produto.ImagemUrl': 'assets/products.png#tile=' + n }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { fields: [{ name: 'CategoriaId', type: 'Integer', lowCardinality: true }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'm:x' });
  assert.equal(root.classExpr, undefined);
  assert.deepEqual(root.attrExpr.class, { fmt: 'substr-after:#tile=', value: { record: 'Produto', field: 'ImagemUrl' }, prefix: 'product-photo tile-', suffix: '', locale: 'pt-BR' });
});

test('annotation: a text of a referenced record reads it through the foreign key (record + via), not cases by the key', () => {
  const names = ['Beleza', 'Higiene', 'Beleza'];
  const trees = names.map(name => el('span', [], [text(name)]));
  const contexts = [3, 2, 3].map(id => row({ CategoriaId: id }));
  const sources = names.map((name, i) => ({ 'record:Produto.CategoriaId': [3, 2, 3][i], 'record:Produto.CategoriaId>Nome': name }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { fields: [{ name: 'CategoriaId', type: 'Integer', lowCardinality: true }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'm:x' });
  assert.deepEqual(root.c[0].expr.value, { record: 'Produto', field: 'Nome', via: 'CategoriaId' });
});

test('annotation: a node present exactly where its parent is inherits the condition (no nested If)', () => {
  const full = el('div', [], [el('section', [], [el('span', [], [text('x')])])]);
  const trees = [full, full, el('div', [], [])];
  const contexts = [{ dims: { d: 'a' } }, { dims: { d: 'a' } }, { dims: { d: 'b' } }];
  const { root } = annotateRegion({ trees, contexts, sources: [], vars: { dims: [{ key: 'd', zero: 'b' }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  assert.deepEqual(root.c[0].if, { op: 'eq', l: { dim: 'd' }, r: { lit: 'a' } });
  assert.equal(root.c[0].c[0].if, undefined);
  assert.equal(root.c[0].c[0].c[0].if, undefined);
});

test('annotation: an input showing its own dimension is the dimension itself, even when empty', () => {
  const trees = ['', 'abc'].map(value => el('input', [['value', value]]));
  const contexts = ['', 'abc'].map(q => ({ dims: { q } }));
  const sources = ['', 'abc'].map(q => ({ 'dim:q': q }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { dims: [{ key: 'q', zero: '', free: true }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  assert.deepEqual(root.attrExpr.value, { fmt: 'text', value: { dim: 'q' }, prefix: '', suffix: '', locale: 'pt-BR' });
});

test('annotation: a bare short value equal to a source in one context only is a coincidence (no template)', () => {
  const values = ['1', '7', '9'];
  const trees = values.map(value => el('small', [], [text(value)]));
  const contexts = ['a', 'b', 'c'].map(d => ({ dims: { d } }));
  const sources = [1, 4, 5].map(id => ({ 'record:Pedido.Id': id }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { dims: [{ key: 'd', zero: 'a' }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  assert.equal(has(root.c[0].expr ?? null, '"field":"Id"'), false, JSON.stringify(root.c[0].expr));
});

test('annotation: a boolean word is never explained by an unrelated source that happens to hold the same word', () => {
  const trees = ['true', 'false', 'false'].map(value => el('button', [['aria-pressed', value]]));
  const contexts = ['0', '1', '2'].map(f => ({ dims: { f } }));
  const sources = ['x', 'false', 'y'].map(value => ({ 'dim:other': value }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { dims: [{ key: 'f', zero: '0' }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  assert.equal(has(root.attrExpr['aria-pressed'], '"dim":"other"'), false, JSON.stringify(root.attrExpr));
  assert.deepEqual(root.attrExpr['aria-pressed'].cases[0], { when: { op: 'eq', l: { dim: 'f' }, r: { lit: '0' } }, value: { lit: 'true' } });
});

test('annotation: plural through the count of a list (v = 1), with the same source in both branches', () => {
  const values = ['1 produto', '7 produtos', '3 produtos'];
  const trees = values.map(value => el('strong', [], [text(value)]));
  const contexts = ['1', '0', '2'].map(category => ({ dims: { category } }));
  const sources = [1, 7, 3].map(count => ({ 'count:0': count }));
  const { root } = annotateRegion({ trees, contexts, sources, vars: { dims: [{ key: 'category', zero: '0' }] }, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  const expr = root.c[0].expr;
  assert.equal(expr.plural, true);
  assert.deepEqual(expr.cases[0].when, { op: 'eq', l: { count: '#0' }, r: { lit: 1 } });
  assert.equal(expr.cases[0].value.suffix, ' produto');
  assert.equal(expr.else.suffix, ' produtos');
});

test('annotation: texts of a node take the variables of its presence (Estoque), not a coincident key (CategoriaId)', () => {
  const button = label => el('div', [], [el('button', [['disabled', '']], [text(label)])]);
  const trees = [button('Indisponível'), button('Somente consulta'), el('div', [], []), el('div', [], [])];
  const contexts = [row({ CategoriaId: 3, Estoque: 0 }, { a: '1' }), row({ CategoriaId: 1, Estoque: 5 }, { a: '3' }), row({ CategoriaId: 2, Estoque: 4 }, { a: '1' }), row({ CategoriaId: 3, Estoque: 6 }, { a: '1' })];
  const vars = { fields: [{ name: 'CategoriaId', type: 'Integer', lowCardinality: true }, { name: 'Estoque', type: 'Integer' }], dims: [{ key: 'a', zero: '1' }] };
  const { root } = annotateRegion({ trees, contexts, sources: [], vars, meta: null, states: [], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'm:x' });
  const node = root.c[0];
  assert.ok(has(node.if, 'Estoque'), JSON.stringify(node.if));
  const expr = node.c[0].expr;
  assert.equal(expr.fmt, 'cases');
  assert.equal(has(expr, 'CategoriaId'), false, JSON.stringify(expr));
  assert.ok(has(expr, 'Estoque'), JSON.stringify(expr));
});

test('annotation: a list item node absent from the first item enters the template in place, with its predicate', () => {
  const rows = [{ Id: 1, Nome: 'Alpha', Destaque: false, Preco: 10 }, { Id: 2, Nome: 'Beta', Destaque: true, Preco: 20 }, { Id: 3, Nome: 'Gamma', Destaque: true, Preco: 30 }, { Id: 4, Nome: 'Delta', Destaque: false, Preco: 40 }];
  const meta = new StoreMeta({ Produto: rows });
  const item = r => el('li', [['class', 'card'], ['data-id', String(r.Id)]], [el('h3', [], [text(r.Nome)]), ...(r.Destaque ? [el('em', [['class', 'tag']], [text('Destaque')])] : []), el('b', [], [text(String(r.Preco))])]);
  const tree = el('main', [], [el('ul', [['class', 'grid']], rows.map(item))]);
  const region = annotateRegion({ trees: [tree], contexts: [{}], sources: [{}], vars: {}, meta, states: [meta.state(null)], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  const list = region.lists[0].list;
  assert.equal(list.collection, 'Produto');
  list.keyField = 'Id';
  const template = listTemplate(list, 'v:x/0/*');
  assert.deepEqual(template.c.map(node => node.t), ['h3', 'em', 'b'], 'the optional tag between the name and the price');
  assert.deepEqual(template.c[1].if, { op: 'truthy', l: { field: 'Destaque' } });
  assert.equal(template.c[1].c[0].if, undefined, 'its text inherits the condition');
  assert.deepEqual(template.c[2].c[0].expr.value, { field: 'Preco' });
});

// ---- names (2.3-2.5) ------------------------------------------------------------------------------------------------

test('names: ASCII PascalCase from the user words; modal slug without digits; prefix from the title or the folder', () => {
  assert.deepEqual([pascal('meus-pedidos'), pascal('Detalhes do produto'), pascal('Gestão'), pascal('3d view')], ['MeusPedidos', 'DetalhesDoProduto', 'Gestao', 'N3dView']);
  assert.equal(modalSlug('Atualizar pedido #1004'), 'atualizar-pedido');
  assert.equal(prefixFrom('FarmaVirtual | Catálogo', 'x'), 'FarmaVirtual');
  assert.equal(prefixFrom('', 'my-proto'), 'MyProto');
  assert.equal(recordInputName('Users', 'pt-BR'), 'UsuarioAtual');
  assert.equal(recordInputName('usuarios', 'pt-BR'), 'UsuarioAtual', 'the singular PascalCase of the collection, like its entity');
  assert.equal(recordInputName('Users', 'en-US'), 'CurrentUser');
  assert.equal(aggregateInputName('CarrinhoItem', 'Quantidade', 'sum'), 'CarrinhoQuantidade');
  const taken = new Set(['App']);
  assert.deepEqual([uniqueName('App', taken), uniqueName('App', taken)], ['App2', 'App3']);
});

test('names: the README route table gives names only for PascalCase cells next to <entry>#<route>', () => {
  const readme = '| Tela | Rota |\n|---|---|\n| Catalogo | `index.html#catalogo` |\n| PedidoDetalhe | index.html#pedido/{id} |\n| texto | index.html#x |';
  assert.deepEqual(readmeRoutes(readme, 'index.html'), [{ name: 'Catalogo', route: 'catalogo' }, { name: 'PedidoDetalhe', route: 'pedido/{id}' }]);
});

// ---- IR (2.10) --------------------------------------------------------------------------------------------------------

test('IR: canonical JSON sorts keys; the hash ignores timings, engine.node and source.root', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
  const base = { schema: SCHEMA, kind: 'static', engine: { jsdom: '30.1.1', node: 'v24' }, source: { root: 'C:/a', files: [] }, timings: { totalMs: 10 } };
  const other = { ...base, engine: { jsdom: '30.1.1', node: 'v22' }, source: { root: 'D:/b', files: [] }, timings: { totalMs: 99 } };
  assert.equal(irHash(base), irHash(other));
  assert.notEqual(irHash(base), irHash({ ...base, kind: 'spa-hash' }));
});

test('IR: the validator rejects a tree whose hash does not match, a missing default view and a bad prefix', () => {
  const tree = { k: 'b', t: 'body' };
  const ir = { schema: SCHEMA, clock: '2026-10-10T21:00:00.000Z', tz: 'UTC', kind: 'static', source: { files: [] }, app: { prefix: 'Cafe' }, views: [{ key: 'home', name: 'Home', default: true, root: { k: 'v:home', t: 'main' } }], explored: [{ id: 'v:home@canonical', tree: treeHash(tree) }], trees: { [treeHash(tree)]: tree } };
  assert.deepEqual(validateIr(ir), []);
  const broken = { ...ir, app: { prefix: 'café 2' }, views: [{ ...ir.views[0], default: false }], trees: { [treeHash(tree)]: { ...tree, t: 'div' } } };
  const problems = validateIr(broken);
  assert.ok(problems.some(item => /prefix/.test(item)));
  assert.ok(problems.some(item => /default/.test(item)));
  assert.ok(problems.some(item => /hash does not match/.test(item)));
});

test('IR: a list reads a collection or a snapshot entity, and the snapshot rows hold only its attributes', () => {
  const tree = { k: 'b', t: 'body' };
  const list = (value) => ({ k: 'v:home', t: 'main', c: [{ k: 'v:home/0', t: 'ul', list: { template: { k: 'v:home/0/*', t: 'li' }, ...value } }] });
  const ir = root => ({ schema: SCHEMA, clock: '2026-10-10T21:00:00.000Z', tz: 'UTC', kind: 'static', source: { files: [] }, app: { prefix: 'Cafe' }, views: [{ key: 'home', name: 'Home', default: true, root }], explored: [], trees: { [treeHash(tree)]: tree } });
  assert.deepEqual(validateIr(ir(list({ collection: 'Produto', snapshot: null }))), []);
  assert.deepEqual(validateIr(ir(list({ collection: null, snapshot: { entity: 'CafeHomeMenu', attributes: [{ name: 'Li', type: 'Text' }], rows: [{ Li: 'Espresso' }] } }))), []);
  assert.ok(validateIr(ir(list({ collection: null, snapshot: null }))).some(item => /collection or a snapshot/.test(item)));
  assert.ok(validateIr(ir(list({ collection: null, snapshot: { entity: 'CafeHomeMenu', attributes: [{ name: 'Li', type: 'Text' }], rows: [{ Other: 'x' }] } }))).some(item => /only its attributes/.test(item)));
});

test('annotation: a static repeated group without a collection is a snapshot list; a group of links stays literal', () => {
  const meta = new StoreMeta({});
  const card = (title, body) => el('li', [['class', 'servico']], [el('h2', [], [text(title)]), el('p', [], [text(body)])]);
  const links = el('nav', [['class', 'menu']], [el('a', [['href', 'a.html']], [text('A')]), el('a', [['href', 'b.html']], [text('B')])]);
  const tree = el('main', [], [el('ul', [['class', 'servicos']], [card('Consulta', 'Clinica'), card('Exames', 'Coleta')]), links]);
  const region = annotateRegion({ trees: [tree], contexts: [{}], sources: [{}], vars: {}, meta, states: [{}], locale: 'pt-BR', tz: 'UTC', keyPrefix: 'v:x' });
  assert.equal(region.lists.length, 1);
  const list = region.lists[0].list;
  assert.deepEqual(list.snapshot.rows, [{ H2: 'Consulta', P: 'Clinica' }, { H2: 'Exames', P: 'Coleta' }]);
  const template = snapshotTemplate(list, 'v:x/0/*');
  assert.deepEqual(template.c.map(node => node.c[0].expr.value), [{ field: 'H2' }, { field: 'P' }]);
});

// ---- CSS inventory (2.9) ----------------------------------------------------------------------------------------------

test('CSS: @import found by tokenization on a minified line; url() outside imports; strings and blocks skipped', () => {
  const css = '@import url("a.css");@import "b.css" screen;.x{background:url(c.png)}.y{content:"@import nope"}@media print{@import "z.css";}';
  assert.deepEqual(cssImports(css), ['url("a.css")', '"b.css" screen']);
  assert.deepEqual(cssUrls(css), ['c.png']);
  assert.equal(localReference('../img/a.png?v=1', 'css/site.css'), 'img/a.png');
  assert.equal(localReference('https://fonts.example/x.woff', 'site.css'), null);
  assert.equal(localReference('../../outside.png', 'site.css'), null);
});

test('CSS: specificity counts ids, classes/attributes/pseudo-classes and types; :where adds nothing, :is takes its best', () => {
  assert.deepEqual(specificity('#a .b > p:hover'), [1, 2, 1]);
  assert.deepEqual(specificity(':where(.x) p'), [0, 0, 1]);
  assert.deepEqual(specificity(':is(#a, .b) p[data-x]'), [1, 1, 1]);
});

// ---- scripts (2.3 source 4) -------------------------------------------------------------------------------------------

test('scripts: route literals by Acorn - assigned hashes are strong, comparisons with the route are weak; delegated branches', () => {
  const analysis = analyzeScripts([{ file: 'app.js', text: [
    "const route = () => (location.hash.slice(1) || 'home').split('/');",
    "function render() { const [page] = route(); if (page === 'carrinho') return 1; switch (page) { case 'pedido': return 2; } }",
    "function go(id) { location.hash = '#pedido/' + id; }",
    "document.addEventListener('click', e => { const a = e.target.dataset.action; if (a === 'add') { state.cart = 1; } });",
    "window.addEventListener('hashchange', render);"
  ].join('\n') }]);
  assert.deepEqual(analysis.strong.map(item => item.route), ['pedido/{id}']);
  assert.deepEqual(analysis.weak.map(item => item.route), ['carrinho', 'pedido']);
  assert.equal(analysis.signals.hashchange, true);
  assert.deepEqual(analysis.branches.get('add'), ['cart']);
  assert.equal(analysis.branchSites.get('add'), 'app.js:4');
});

// ---- vendor cache and network (2.1) -----------------------------------------------------------------------------------

test('vendor: only allowlisted hosts, from the content-addressed cache; a tampered file is a cache miss', async () => {
  const cacheDir = path.join(tmp, 'vendor');
  const url = 'https://cdn.jsdelivr.net/npm/x@1.0.0/x.min.js';
  storeInCache(cacheDir, url, Buffer.from('window.X = 1;'));
  const ok = await resolveVendors([url], { cacheDir });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.vendors.get(url).from, 'cache');
  const index = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
  fs.writeFileSync(path.join(cacheDir, index[url]), 'window.X = 2;');
  const tampered = await resolveVendors([url], { cacheDir });
  assert.equal(tampered.problems[0].reason, 'offline');
  const foreign = await resolveVendors(['https://evil.example/x.js'], { cacheDir });
  assert.equal(foreign.problems[0].reason, 'host');
  assert.equal(suggestedVendorPath('C:/p', url), path.join('C:/p', 'vendor', 'x.min.js'));
});

test('network: only same-origin paths inside the source folder map to files', () => {
  assert.equal(localPath('http://prototype.ssam/js/app.js'), 'js/app.js');
  assert.equal(localPath('http://prototype.ssam/a/../b.css'), 'b.css');
  assert.equal(localPath('http://prototype.ssam/%2e%2e/root.txt'), 'root.txt', 'the URL parser keeps dot segments inside the origin root');
  assert.equal(localPath('http://prototype.ssam/a%2f..%2f..%2fsecret.txt'), null, 'encoded separators cannot climb out of the source folder');
  assert.equal(localPath('https://evil.example/x.js'), null);
  assert.equal(localPath('http://prototype.ssam/'), null);
});

// ---- perturbation (2.6) -----------------------------------------------------------------------------------------------

test('perturbation: a valid sentinel that differs from the current value; one invalid value per constraint', () => {
  const quantity = el('input', [['type', 'number'], ['min', '1'], ['max', '10'], ['value', '10']]);
  assert.equal(sentinel(quantity), '9');
  const name = el('input', [['name', 'Nome'], ['required', ''], ['minlength', '3'], ['maxlength', '5']]);
  assert.equal(sentinel(name), 'SSAM ');
  assert.deepEqual(invalidValues(name).map(item => [item.constraint, item.value]), [['required', ''], ['minlength', 'xx'], ['maxlength', 'xxxxxx']]);
  assert.deepEqual(invalidValues(quantity).map(item => [item.constraint, item.value]), [['min', '0'], ['max', '11']]);
  const rows = [{ Nome: 'Dipirona 500 mg', Descricao: 'Analgésico' }, { Nome: 'Hidratante facial', Descricao: 'Pele seca' }];
  assert.deepEqual(searchWords(rows, ['Nome', 'Descricao']), [{ field: 'Nome', word: 'dipirona' }, { field: 'Descricao', word: 'analgesico' }, { field: null, word: 'zzzz-ssam' }]);
});

// ---- refusal patches (2.11) -------------------------------------------------------------------------------------------

test('patches: mapping parents are created once; keys are JSON-pointer escaped; an empty mapping counts as absent', () => {
  const additions = [{ keys: ['vendor', 'https://x.test/a.js'], value: 'vendor/a.js' }, { keys: ['vendor', 'https://x.test/b.js'], value: 'vendor/b.js' }, { keys: ['default'], value: 'home' }];
  assert.deepEqual(mappingPatches({}, additions, '/ops/0/data'), [
    [{ op: 'add', path: '/ops/0/data/mapping', value: { vendor: { 'https://x.test/a.js': 'vendor/a.js' } } }],
    [{ op: 'add', path: '/ops/0/data/mapping/vendor/https:~1~1x.test~1b.js', value: 'vendor/b.js' }],
    [{ op: 'add', path: '/ops/0/data/mapping/default', value: 'home' }]
  ]);
  assert.deepEqual(mappingPatches({ screens: {} }, additions.slice(2), '/ops/0/data'), [[{ op: 'add', path: '/ops/0/data/mapping/default', value: 'home' }]]);
});

// ---- screens as fixed sections, the data object of several collections, unique selectors (the Morada formats) ---------

const sx = (t, a = [], c = [], extra = {}) => ({ t, a, c, ...extra });
const section = (view, hidden, text) => sx('section', [['class', 'view'], ['data-view', view]], [sx('h1', [], [{ x: text }])], hidden ? { h: true } : {});
const routedBody = shown => sx('body', [], [sx('header', [['class', 'topbar']]), sx('main', [], ['buscar', 'imovel', 'painel'].map(view => section(view, view !== shown, view + ' ' + shown))), sx('dialog', [['id', 'dlg']], [], { h: true }), sx('footer')]);

test('sections: the parent whose sections show one at a time per route is the mount; each route its visible section', () => {
  const bodies = [routedBody('buscar'), routedBody('imovel'), routedBody('painel'), routedBody('buscar')];
  const found = toggledSections(bodies, { modalContainer: node => node.t === 'dialog' });
  assert.deepEqual(found.parent, [1], 'main');
  assert.deepEqual(found.sections, [0, 1, 2]);
  assert.deepEqual(bodies.map(found.visible), [0, 1, 2, 0]);
  // one section only, or sections that never alternate, are no routed sections
  assert.equal(toggledSections([routedBody('buscar'), routedBody('buscar')]), null);
  // what a user sees: hidden sections and the closed dialog left out; a control inside them is hidden
  assert.deepEqual(visibleBody(routedBody('imovel')).c[1].c.map(node => node.a[1][1]), ['imovel']);
  assert.equal(hiddenAt(routedBody('imovel'), [1, 0, 0]), true);
  assert.equal(hiddenAt(routedBody('imovel'), [1, 1, 0]), false);
});

test('selectors: a refusal names an element by a selector that matches it alone, and mapping.shell.mount reads it', () => {
  const body = routedBody('buscar');
  assert.equal(uniqueSelector(body, [1, 1]), 'section.view[data-view="imovel"]');
  assert.equal(uniqueSelector(body, [1]), 'main');
  const parent = body.c[1];
  assert.equal(matchesSelector(parent.c[1], 'section.view[data-view="imovel"]', parent), true);
  assert.equal(matchesSelector(parent.c[0], 'section.view[data-view="imovel"]', parent), false);
  assert.equal(matchesSelector(parent.c[2], 'section:nth-of-type(3)', parent), true);
  assert.equal(matchesSelector(parent.c[2], 'section > h1', parent), false, 'combinators are not selectors of one element');
});

test('store: a data object with several record lists, Sets, counters and scalars gives one collection per record list', () => {
  const data = {
    cidades: ['São Paulo', 'Campinas'],
    usuarios: [{ id: 1, nome: 'Ana' }, { id: 2, nome: 'Bruno' }],
    imoveis: [{ id: 101, titulo: 'Apto', fotos: ['a.svg', 'b.svg'], proprietarioId: 2 }, { id: 102, titulo: 'Casa', fotos: ['c.svg'], proprietarioId: 2 }],
    propostas: [{ id: 501, imovelId: 101, valor: 3000 }],
    visitas: [],
    favoritos: new Set([102]),
    usuarioAtualId: null,
    proximoId: { imovel: 103 }
  };
  const collections = recordCollections(data);
  assert.deepEqual(Object.keys(collections).sort(), ['favoritos', 'imoveis', 'imoveisFotos', 'propostas', 'usuarios']);
  assert.equal(collections.imoveis[0].fotos, 'a.svg', 'a list of plain values keeps its first value');
  assert.deepEqual(collections.imoveisFotos, [{ imovelId: 101, foto: 'a.svg', ordem: 1 }, { imovelId: 101, foto: 'b.svg', ordem: 2 }, { imovelId: 102, foto: 'c.svg', ordem: 1 }]);
  assert.deepEqual(collections.favoritos, [{ imovelId: 102 }], 'a Set of keys names the collection it points to');
  // the plural the s rule misses still resolves the foreign key (imovelId -> imoveis)
  const typed = typeCollections(collections);
  assert.deepEqual(typed.find(item => item.name === 'propostas').references, [{ field: 'imovelId', collection: 'imoveis' }]);
  assert.deepEqual(['imoveis', 'pedidos', 'itens', 'cores', 'botoes'].map(singularOf), ['imovel', 'pedido', 'item', 'cor', 'botao']);
  // an object with functions is an API, never a store
  assert.equal(recordCollections({ itens: [{ id: 1 }], salvar() {} }), null);
});

test('patches: the mapping a refusal would leave is what its additions say (the discovery runs again with it)', () => {
  assert.deepEqual(mappingWith({ ignore: ['#x'] }, [{ keys: ['default'], value: '/buscar' }, { keys: ['shell'], value: { mount: 'main' } }, { keys: ['states', 'painel'], value: { conta: '2' } }]),
    { ignore: ['#x'], default: '/buscar', shell: { mount: 'main' }, states: { painel: { conta: '2' } } });
});
test('names: the field names of the model are PascalCase everywhere the IR names a field; collections, keys and views stay', () => {
  const ir = {
    store: { source: 'global:MoradaData', collections: [{ name: 'propostas', key: 'id', fields: [{ name: 'id' }, { name: 'imovelId' }], references: [{ field: 'imovelId', collection: 'imoveis' }], rows: [{ id: 1, imovelId: 101 }] }] },
    views: [{ key: 'painel', root: { k: 'v:painel', list: { collection: 'propostas', filter: { op: 'eq', l: { field: 'proprietarioId', via: 'imovelId' }, r: { dim: 'login-usuario' } }, sort: [{ field: 'enviadaEm', dir: 'desc' }] } } }],
    events: [{ key: 'painel:click:x', effects: [{ kind: 'update', collection: 'propostas', key: { param: 'Id' }, fields: { status: { lit: 'aceita' } } }, { kind: 'insertFrom', target: 'pedidos', source: 'carrinho', fields: { produtoId: { source: 'produtoId' } } }] }],
    trees: { h: { t: 'div', a: [['data-field', 'x']] } }
  };
  const out = pascalFields(ir);
  assert.deepEqual(out.store.collections[0].fields.map(field => field.name), ['Id', 'ImovelId']);
  assert.equal(out.store.collections[0].key, 'Id');
  assert.deepEqual(out.store.collections[0].rows, [{ Id: 1, ImovelId: 101 }]);
  assert.deepEqual(out.store.collections[0].references, [{ field: 'ImovelId', collection: 'imoveis' }]);
  assert.deepEqual(out.views[0].root.list.filter.l, { field: 'ProprietarioId', via: 'ImovelId' });
  assert.equal(out.views[0].root.list.sort[0].field, 'EnviadaEm');
  assert.deepEqual(out.events[0].effects[0].fields, { Status: { lit: 'aceita' } });
  assert.deepEqual(out.events[0].effects[1], { kind: 'insertFrom', target: 'pedidos', source: 'carrinho', fields: { ProdutoId: { source: 'ProdutoId' } } });
  assert.equal(out.views[0].key, 'painel');
  assert.equal(out.store.source, 'global:MoradaData', 'the provenance of the store is no field');
  assert.deepEqual(out.trees, ir.trees, 'the explored DOM is never touched');
});

test('effects: add-when-missing and remove-when-there over a Set of keys is one membership toggle by the event parameter', () => {
  const meta = { byName: new Map([['favoritos', { name: 'favoritos', key: 'imovelId', fields: [{ name: 'imovelId' }] }], ['imoveis', { name: 'imoveis', key: 'id', fields: [{ name: 'id' }, { name: 'titulo' }] }]]) };
  const cases = [
    { when: { op: 'le', l: { field: 'aluguel' }, r: { lit: 4100 } }, effects: [{ kind: 'remove', collection: 'favoritos', key: { param: 'Id' } }, { kind: 'toast', text: { lit: 'Removido' } }] },
    { when: null, effects: [{ kind: 'insert', collection: 'favoritos', fields: { imovelId: { lit: 102 } } }, { kind: 'toast', text: { lit: 'Salvo' } }] }
  ];
  assert.deepEqual(membershipToggle(cases, meta), [{ kind: 'toggle', collection: 'favoritos', keys: { imovelId: { param: 'Id' } } }]);
  // a collection with fields of its own is no Set: the cases stay
  assert.equal(membershipToggle([cases[0], { when: null, effects: [{ kind: 'insert', collection: 'imoveis', fields: {} }] }], meta), null);
});
test('formats: several fields with the same literals between them are one concat; a count takes its noun in the singular for 1', () => {
  const rows = [
    { Bairro: 'República', Cidade: 'São Paulo', Tipo: 'Studio', Vagas: 0, Quartos: 1 },
    { Bairro: 'Campeche', Cidade: 'Florianópolis', Tipo: 'Apartamento', Vagas: 1, Quartos: 2 },
    { Bairro: 'Batel', Cidade: 'Curitiba', Tipo: 'Apartamento', Vagas: 2, Quartos: 3 }
  ];
  const columns = ['Bairro', 'Cidade', 'Tipo', 'Vagas', 'Quartos'].map(name => ({ name, values: rows.map(row => row[name]) }));
  const texts = rows.map(row => `${row.Bairro}, ${row.Cidade} · ${row.Tipo}`);
  const concat = explainConcat(texts, columns, { locale: 'pt-BR' });
  assert.deepEqual(concat.parts.map(part => [columns[part.column].name, part.fmt, part.prefix, part.suffix]), [['Bairro', 'text', '', ''], ['Cidade', 'text', ', ', ''], ['Tipo', 'text', ' · ', '']]);
  // literals that differ between items are no concat (the count with its noun is)
  const vagas = rows.map(row => row.Vagas + (row.Vagas === 1 ? ' vaga' : ' vagas'));
  assert.equal(explainConcat(vagas, columns, { locale: 'pt-BR' }), null);
  const count = explainCount(vagas, columns);
  assert.deepEqual(count, { column: 3, one: { prefix: '', suffix: ' vaga' }, other: { prefix: '', suffix: ' vagas' } });
  // the column whose 1 is not where the singular is never explains it (Quartos is 1 in the first item, which says "vagas")
  assert.notEqual(columns[count.column].name, 'Quartos');
});

// Fakes of the other lanes' interfaces for the surface lane tests (docs/PROTOTIPO-NATIVO.md 7.1-7.4): the capture engine
// (prototype/capture.mjs capturePrototype), the kernel's report.prototype and prototype-dom.json (compile and css lanes)
// and the fidelity measure (prototype/fidelity.mjs measureFidelity). The IR is a small FarmaVirtual subset with the shape
// of section 2.10; its source.files are the real files of the fixture folder next to this file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from '../../../prototype-op.mjs';

export const FARMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'farmavirtual');
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function farmaFolder(tmp) {
  // A private copy, so a test may change a file of the prototype.
  const dir = path.join(tmp, 'farmavirtual');
  fs.cpSync(FARMA, dir, { recursive: true });
  return dir;
}

const node = (k, t, attrs = [], children = [], extra = {}) => ({ k, t, a: attrs, c: children, ...extra });
const text = (k, x) => ({ k, x });

export function farmaIr(source) {
  const files = ['index.html', 'app.js', 'model.js', 'styles.css', 'README.md'].filter(f => fs.existsSync(path.join(source, f)))
    .map(f => { const bytes = fs.readFileSync(path.join(source, f)); return { path: f, bytes: bytes.length, sha256: sha256(bytes) }; });
  const produtos = [[1, 1, 'Hidratante facial 50 g', 49.9, 24, true, true], [2, 1, 'Sabonete líquido 250 ml', 19.9, 8, false, true], [3, 2, 'Protetor solar FPS 50', 69.9, 0, true, true],
    [4, 2, 'Batom hidratante', 29.9, 12, false, true], [5, 3, 'Vitamina C 60 cápsulas', 39.9, 30, false, true], [6, 3, 'Chá calmante', 14.9, 5, false, true],
    [7, 1, 'Escova dental macia', 9.9, 40, false, true], [8, 2, 'Máscara capilar', 44.9, 3, false, false]]
    .map(([Id, CategoriaId, Nome, Preco, Estoque, Destaque, Ativo]) => ({ Id, CategoriaId, Nome, Preco, Estoque, Destaque, Ativo, ImagemUrl: 'assets/products.png#tile=' + (Id - 1) }));
  return {
    schema: 'ssam-prototype-capture/1', clock: '2026-10-10T04:07:40Z', tz: 'UTC',
    engine: { name: 'jsdom', version: '30.1.1', node: process.version },
    source: { root: source, entry: 'index.html', files, vendor: [] },
    kind: 'spa-hash',
    app: { prefix: 'FarmaVirtual', title: 'FarmaVirtual | Higiene, beleza e bem-estar', lang: 'pt-BR' },
    document: { html: [['lang', 'pt-BR']], body: [], meta: [{ name: 'theme-color', content: '#18765c' }] },
    css: { sheets: [{ path: 'styles.css', bundle: 'sheets/styles.css', order: 0, origin: 'file', page: null, bytes: 1, sha256: 'x', rules: 271, imports: [], urls: [] }] },
    assets: [], icons: { library: 'lucide', defaultStrokeWidth: 1.7, tag: 'span', set: {} },
    dimensions: [{ key: 'account-select', name: 'AccountSelect', control: 'select#account-select', event: 'change', type: 'Integer', values: ['0', '1', '2', '3'], initial: '1', scope: 'global' }],
    store: { source: 'global:FarmaModel.seed()', collections: [
      { name: 'PedidoItem', key: 'Id', mutated: true, fields: [{ name: 'Id', type: 'Integer' }], references: [{ field: 'PedidoId', collection: 'Pedido' }, { field: 'ProdutoId', collection: 'Produto' }],
        rows: [{ Id: 1, PedidoId: 1003, ProdutoId: 1, Quantidade: 2 }, { Id: 2, PedidoId: 1003, ProdutoId: 3, Quantidade: 1 }] },
      { name: 'Categoria', key: 'Id', mutated: false, fields: [{ name: 'Id', type: 'Integer' }], references: [], rows: [{ Id: 1, Nome: 'Higiene' }, { Id: 2, Nome: 'Beleza' }, { Id: 3, Nome: 'Bem-estar' }] },
      { name: 'Produto', key: 'Id', mutated: true, fields: [{ name: 'Id', type: 'Integer' }, { name: 'Nome', type: 'Text', length: 120 }], references: [{ field: 'CategoriaId', collection: 'Categoria' }], rows: produtos },
      { name: 'CarrinhoItem', key: 'Id', mutated: true, fields: [{ name: 'Id', type: 'Integer' }], references: [{ field: 'ProdutoId', collection: 'Produto' }], rows: [{ Id: 1, UserId: 1, ProdutoId: 1, Quantidade: 1 }, { Id: 2, UserId: 1, ProdutoId: 5, Quantidade: 2 }] },
      { name: 'Pedido', key: 'Id', mutated: true, fields: [{ name: 'Id', type: 'Integer' }], references: [], rows: [1004, 1003, 1002, 1001, 1000].map(Id => ({ Id, UserId: Id % 2 ? 1 : 2, StatusPedidoId: 1, CriadoEm: '2026-10-09T16:07:40Z', Total: 32.9 })) },
    ] },
    shell: { root: node('s:app', 'div', [['id', 'app']], [
      node('s:app/0', 'header', [['class', 'site-header']], [node('s:app/0/0', 'a', [['class', 'brand'], ['href', '#catalogo']], [text('s:app/0/0/0', 'FarmaVirtual')])]),
      node('s:app/1', 'main', [['class', 'main']], []),
    ]), regions: [0, 1], mount: { region: 1, path: [1] }, inputs: [{ name: 'View', type: 'Text' }], events: [] },
    views: [
      { key: 'catalogo', route: '#catalogo', template: 'catalogo', params: [], name: 'Catalogo', nameSource: 'readme', default: true, state: { 'account-select': '1' },
        root: node('v:catalogo', 'section', [['class', 'catalog']], [
          node('v:catalogo/0', 'div', [['class', 'product-grid']], [
            node('v:catalogo/0/0', 'article', [['class', 'product-card'], ['data-id', '1']], [
              node('v:catalogo/0/0/0', 'h3', [], [text('v:catalogo/0/0/0/0', 'Hidratante facial 50 g')]),
              node('v:catalogo/0/0/1', 'button', [['class', 'btn add'], ['data-action', 'add'], ['data-id', '1']], [text('v:catalogo/0/0/1/0', 'Adicionar')], { events: ['catalogo:click:add'] }),
              node('v:catalogo/0/0/2', 'span', [['class', 'stock-label'], ['data-x', 'odd']], [text('v:catalogo/0/0/2/0', 'Disponível em estoque')]),
            ]),
          ]),
        ]), elements: 6 },
      { key: 'pedido', route: '#pedido/1003', template: 'pedido/{id}', params: [{ name: 'Id', type: 'Integer' }], name: 'PedidoDetalhe', nameSource: 'readme', default: false, state: { 'account-select': '1' },
        root: node('v:pedido', 'section', [['class', 'order-detail'], ['id', 'order']], [node('v:pedido/0', 'h1', [], [text('v:pedido/0/0', 'Pedido #1003')])]), elements: 2 },
    ],
    modals: [{ key: 'detalhes-do-produto', name: 'DetalhesDoProduto', container: { tag: 'dialog', attrs: [['id', 'modal']], class: 'product-modal' },
      openedFrom: [{ view: 'catalogo', event: 'catalogo:click:product-detail' }], params: [{ name: 'Id', from: 'data-id', type: 'Integer' }],
      root: node('m:detalhes-do-produto', 'div', [['class', 'modal-body']], [node('m:detalhes-do-produto/0', 'h2', [['id', 'modal-title']], [text('m:detalhes-do-produto/0/0', 'Detalhes do produto')])]), elements: 2 }],
    events: [{ key: 'catalogo:click:add', view: 'catalogo', selector: '[data-action="add"]', on: 'click', params: [{ name: 'Id', from: 'data-id', type: 'Integer' }],
      effects: [{ kind: 'upsert', collection: 'CarrinhoItem' }, { kind: 'toast' }], when: null, handler: 'app.js:300', compiled: true }],
    explored: [{ id: 'v:catalogo@canonical', view: 'catalogo', assign: {}, tree: 'x' }],
    trees: {}, problems: [], warnings: [],
    stats: { elements: 922, views: 6, modals: 5, icons: 33, iconInstances: 118, events: 1, probes: 300 },
    timings: { loadMs: 1, crawlMs: 1, probeMs: 1, inferMs: 1, totalMs: 4 },
  };
}

// The capture engine: writes <out>/capture.json and answers the interface of 7.1. problems: answer them instead.
export function fakeCapture({ problems = null, calls = [] } = {}) {
  return async args => {
    calls.push(args);
    if (problems) return { ok: false, problems: typeof problems === 'function' ? problems(args) : problems, warnings: [] };
    const ir = farmaIr(args.source);
    fs.mkdirSync(args.out, { recursive: true });
    const capturePath = path.join(args.out, 'capture.json');
    fs.writeFileSync(capturePath, JSON.stringify(ir));
    return { ok: true, capturePath, bundle: args.out, sha256: canonicalSha256(ir),
      summary: { kind: ir.kind, views: 6, modals: 5, elements: 922, icons: 33, events: 1, compiled: 1, probes: 300, windows: 12, pool: 8 }, problems: [], warnings: [] };
  };
}

// report.prototype of the kernel (compile lane) for FarmaVirtual, with the path of its prototype-dom.json.
export function kernelReport({ nativeDom = null } = {}) {
  return {
    schema: 'ssam-prototype-receipt/1',
    source: { root: FARMA, entry: 'index.html', kind: 'spa-hash', clock: '2026-10-10T04:07:40Z', tz: 'UTC' },
    flow: 'FarmaVirtual', theme: 'FarmaVirtualTheme',
    screens: [
      { name: 'Catalogo', view: 'catalogo', route: '#catalogo', default: true, inputs: [], popups: ['DetalhesDoProduto', 'EntreNaSuaConta'], widgets: 310, elements: 300 },
      { name: 'FarmaVirtualCarrinho', renamedFrom: 'Carrinho', why: 'tela Carrinho sem marca já existe no módulo', view: 'carrinho', route: '#carrinho', default: false, inputs: [], popups: [], widgets: 120, elements: 110 },
      { name: 'PedidoDetalhe', view: 'pedido', route: '#pedido/1003', default: false, inputs: ['Id'], popups: ['AtualizarPedido'], widgets: 90, elements: 80 },
    ],
    blocks: [{ name: 'FarmaVirtualShell', role: 'shell', instances: 6, placeholder: 'Content', inputs: ['View'], events: [] }, { name: 'AtualizarPedido', role: 'modal', instances: 2 }],
    popups: [{ name: 'DetalhesDoProduto', modal: 'detalhes-do-produto', screens: ['Catalogo'], inputs: ['Id'], load: 'ListIndexOf' }],
    resources: { images: [{ name: 'FarmaVirtualProducts', file: 'assets/products.png', bytes: 1476828, warnings: ['ImageTooBig'] }], icons: { library: 'lucide', distinct: 33, instances: 118, tag: 'span' }, imports: [] },
    data: { staticEntities: [{ name: 'FarmaVirtualCategoria', records: 3 }],
      entities: [{ name: 'FarmaVirtualProduto', collection: 'Produto', rows: 8, seeded: 0, autoNumber: false },
        { name: 'FarmaVirtualCarrinhoItem', collection: 'CarrinhoItem', rows: 2, seeded: 0, autoNumber: false },
        { name: 'FarmaVirtualPedido', collection: 'Pedido', rows: 5, seeded: 0, autoNumber: false },
        { name: 'FarmaVirtualPedidoItem', collection: 'PedidoItem', rows: 2, seeded: 0, autoNumber: false },
        { name: 'Carrinho', collection: 'CarrinhoItem', rows: 2, marked: false }],
      extraAttributes: [], serverActions: 6, sql: 3, clientVariables: [{ name: 'FarmaVirtualAccountSelect', type: 'Integer', default: '1' }] },
    events: { total: 30, compiled: 30, byEffect: { navigate: 4, openPopup: 5, upsert: 1 }, notCompiled: [], targetGuarded: [{ event: 'modal:click', handler: 'app.js:344', why: 'fecha pelo clique no fundo' }] },
    fidelity: { css: { verbatim: true, rules: 271, rewrites: [{ kind: 'asset-url', count: 1 }, { kind: 'import-hoist', count: 1 }] }, wrappers: [{ widget: 'IMobileBlockInstanceWidget', count: 6, adapter: 'display:contents' }], runtimeUnverified: [] },
    verifyWarnings: { total: 34, byCode: { InvalidResourceURL_Offline: 34 } },
    counts: { ops: 64, widgets: 2210, extendedProperties: 900, screenActions: 40, serverActions: 6, ifWidgets: 60, lists: 9 },
    capture: { probes: 300, windows: 12, pool: 8 },
    timings: { expandMs: 1200, verifyMs: 9000 },
    outOfScope: [{ what: 'fechamento do toast após 5500 ms', where: 'app.js:43', why: 'sem timer de cliente nativo' }],
    padroes: { notes: [{ rule: 'AR2', note: 'a conta é simulada pelo protótipo' }] },
    modelBytes: 312,
    ...(nativeDom ? { nativeDom } : {}),
  };
}

// The fidelity measure (render lane): equal trees, per state.
export const fakeMeasure = (calls = []) => ({ capture, nativeDom }) => {
  calls.push({ capture, nativeDom });
  return { states: 2, elements: { prototype: 922, matched: 922 }, score: 1.0, classes: { prototype: 500, matched: 500 }, texts: { prototype: 300, matched: 300 },
    attributes: { prototype: 400, matched: 400 }, selectors: { rules: 271, selectors: 390, equal: 390, gained: 0, lost: 0 },
    perState: [{ state: 'v:catalogo@canonical', score: 1.0, selectorsDiff: 0 }, { state: 'm:detalhes-do-produto@canonical', score: 1.0, selectorsDiff: 0 }], mismatches: [] };
};

// prototype-dom.json as the css lane writes it (only its existence matters to the facade).
export function writeNativeDom(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prototype-dom.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-prototype-dom/1', states: [{ state: 'v:catalogo@canonical', tree: { t: 'section' } }] }));
  return file;
}

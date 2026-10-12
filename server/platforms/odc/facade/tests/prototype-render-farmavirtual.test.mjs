// Prototype capture (docs/PROTOTIPO-NATIVO.md 2, 7.1 tests 1-8 and 12) over the owner's FarmaVirtual prototype.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePrototype, closeResidentPools } from '../prototype/capture.mjs';
import { irHash, walk } from '../prototype/ir.mjs';
import { verifyBundle } from '../prototype/bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'fixtures', 'prototype', 'farmavirtual');
const clock = '2026-10-10T21:00:00Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-fv-'));
after(() => { closeResidentPools(); fs.rmSync(tmp, { recursive: true, force: true }); });

let first = null;
async function capture() {
  if (!first) first = await capturePrototype({ source, clock, pool: 8, out: path.join(tmp, 'bundle') });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  return first;
}

const findEvent = (ir, key) => ir.events.find(event => event.key === key);
const effectKinds = event => event.effects.map(effect => effect.kind);
function nodes(root) { const out = []; walk(root, node => { out.push(node); if (node.list?.template) walk(node.list.template, inner => { out.push(inner); }); }); return out; }

test('1. spa-hash: the states x routes fixpoint finds the 6 README views, the admin ones only with account-select = 3', async () => {
  const { ir } = await capture();
  assert.equal(ir.kind, 'spa-hash');
  assert.deepEqual(ir.views.map(view => view.name), ['Catalogo', 'Carrinho', 'MeusPedidos', 'PedidoDetalhe', 'GestaoProdutos', 'GestaoPedidos']);
  assert.deepEqual(ir.views.map(view => view.nameSource), ['readme', 'readme', 'readme', 'readme', 'readme', 'readme']);
  const byName = Object.fromEntries(ir.views.map(view => [view.name, view]));
  assert.equal(byName.Catalogo.default, true);
  assert.equal(ir.views.filter(view => view.default).length, 1);
  assert.equal(byName.PedidoDetalhe.template, 'pedido/{id}');
  assert.equal(byName.PedidoDetalhe.route, '#pedido/1003', 'the first #pedido/<n> of meus-pedidos in its canonical state');
  assert.deepEqual(byName.PedidoDetalhe.params, [{ name: 'Id', from: 'route', type: 'Integer' }]);
  for (const name of ['Catalogo', 'Carrinho', 'MeusPedidos', 'PedidoDetalhe']) assert.deepEqual(byName[name].state, {}, name + ' is canonical in S0 (account 1)');
  for (const name of ['GestaoProdutos', 'GestaoPedidos']) assert.deepEqual(byName[name].state, { 'account-select': '3' }, name + ' only renders with account 3');
  const account = ir.dimensions.find(dim => dim.key === 'account-select');
  assert.equal(account.scope, 'global');
  assert.equal(account.initial, '1');
  assert.deepEqual(account.values, ['0', '1', '2', '3']);
});

test('1b. the same views without the README (hrefs, observed navigation, script literals), names from the routes', async () => {
  const copy = path.join(tmp, 'farmavirtual-no-readme');
  fs.cpSync(source, copy, { recursive: true });
  fs.rmSync(path.join(copy, 'README.md'));
  const result = await capturePrototype({ source: copy, clock, pool: 8 });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const templates = result.ir.views.map(view => view.template).sort();
  assert.deepEqual(templates, ['carrinho', 'catalogo', 'gestao-pedidos', 'gestao-produtos', 'meus-pedidos', 'pedido/{id}']);
  const names = Object.fromEntries(result.ir.views.map(view => [view.template, view.name]));
  assert.equal(names['pedido/{id}'], 'Pedido');
  assert.equal(names['meus-pedidos'], 'MeusPedidos');
  assert.equal(result.ir.views.find(view => view.default).template, 'catalogo');
  assert.deepEqual(result.ir.views.find(view => view.template === 'gestao-produtos').state, { 'account-select': '3' });
});

test('2. five modal kinds typed by the title slug, with screens and inputs; the backdrop listener is target-guarded', async () => {
  const { ir } = await capture();
  const modals = Object.fromEntries(ir.modals.map(modal => [modal.key, modal]));
  assert.deepEqual(Object.keys(modals).sort(), ['atualizar-pedido', 'detalhes-do-produto', 'editar-produto', 'entre-na-sua-conta', 'novo-produto']);
  const expect = {
    'detalhes-do-produto': { name: 'DetalhesDoProduto', screens: ['catalogo'], inputs: ['Id'] },
    'entre-na-sua-conta': { name: 'EntreNaSuaConta', screens: ['catalogo'], inputs: [] },
    'editar-produto': { name: 'EditarProduto', screens: ['gestao-produtos'], inputs: ['Id'] },
    'novo-produto': { name: 'NovoProduto', screens: ['gestao-produtos'], inputs: [] },
    'atualizar-pedido': { name: 'AtualizarPedido', screens: ['pedido', 'gestao-pedidos'], inputs: ['Id'] }
  };
  for (const [key, value] of Object.entries(expect)) {
    assert.equal(modals[key].name, value.name);
    assert.deepEqual([...modals[key].screens].sort(), [...value.screens].sort(), key);
    assert.deepEqual(modals[key].params.map(param => param.name), value.inputs, key);
  }
  assert.equal(modals['detalhes-do-produto'].container.class, 'product-modal');
  assert.equal(modals['detalhes-do-produto'].container.tag, 'dialog');
  assert.ok(modals['entre-na-sua-conta'].openedFrom.some(item => item.event === 'catalogo:click:add'));
  assert.ok(modals['entre-na-sua-conta'].openedFrom.some(item => item.modal === 'detalhes-do-produto'), 'opened from inside the product modal');
  assert.ok(ir.targetGuarded.some(item => item.handler === 'app.js:344'), JSON.stringify(ir.targetGuarded));
  assert.ok(ir.outOfScope.some(item => item.where === 'app.js:344'));
  assert.ok(ir.events.every(event => !/:click:modal$/.test(event.key)), 'the container listener never becomes an element event');
});

test('3. shell: #app root, five regions with main as the mount, #notifications, block inputs and events', async () => {
  const { ir } = await capture();
  const shell = ir.shell;
  assert.equal(shell.root.t, 'div');
  assert.deepEqual(shell.root.a, [['id', 'app']]);
  const roles = Object.fromEntries(shell.regionInfo.map(item => [item.name, item.role]));
  assert.deepEqual(roles, { 'demo-strip': 'region', 'site-header': 'region', 'main-nav': 'region', 'main-content': 'mount', 'site-footer': 'region', notifications: 'sibling' });
  const mount = shell.root.c[shell.mount.region];
  assert.equal(mount.t, 'main');
  assert.equal(mount.c, undefined, 'the placeholder sits inside main');
  assert.equal(shell.siblings[0].k, 's:notifications');
  assert.deepEqual(shell.inputs.map(input => input.name).sort(), ['AccountSelect', 'AvisoErro', 'Aviso', 'CarrinhoQuantidade', 'CatalogSearch', 'UsuarioAtual', 'View'].sort());
  assert.deepEqual(shell.events.map(event => event.name).sort(), ['AccountSelectAlterada', 'CatalogSearchAlterada', 'FecharAviso']);
  const usuario = shell.inputs.find(input => input.name === 'UsuarioAtual');
  assert.deepEqual(usuario.source, { record: 'Users', by: 'account-select' });
});

test('4. 922 elements, 33 icons, 118 icon instances (an icon counts as one element)', async () => {
  const { ir, summary } = await capture();
  assert.equal(ir.stats.elements, 922);
  assert.equal(ir.stats.icons, 33);
  assert.equal(ir.stats.iconInstances, 118);
  assert.equal(summary.elements, 922);
  assert.equal(ir.icons.defaultStrokeWidth, 1.7);
  assert.equal(ir.icons.tag, 'span');
  const brand = nodes(ir.shell.root).find(node => node.icon?.name === 'plus');
  assert.equal(brand.icon.strokeWidth, 3, 'the winning .brand-mark .icon rule');
  assert.deepEqual(brand.icon.from, [['class', 'icon'], ['aria-hidden', 'true']]);
  assert.equal(brand.c, undefined, 'paths are never kept');
});

test('5. store: FarmaModel.seed() with 6 collections plus Users, the mutated ones marked', async () => {
  const { ir } = await capture();
  assert.equal(ir.store.source, 'global:FarmaModel.seed()');
  const collections = Object.fromEntries(ir.store.collections.map(collection => [collection.name, collection]));
  assert.deepEqual(Object.keys(collections), ['Categoria', 'Produto', 'CarrinhoItem', 'Pedido', 'PedidoItem', 'StatusPedido', 'Users']);
  assert.equal(collections.Produto.rows.length, 8);
  assert.equal(collections.Users.origin, 'array:FarmaModel.create().Users');
  for (const name of ['Produto', 'CarrinhoItem', 'Pedido', 'PedidoItem']) assert.equal(collections[name].mutated, true, name);
  for (const name of ['Categoria', 'StatusPedido', 'Users']) assert.equal(collections[name].mutated, false, name);
  assert.deepEqual(collections.CarrinhoItem.references, [{ field: 'UserId', collection: 'Users' }, { field: 'ProdutoId', collection: 'Produto' }]);
  assert.equal(collections.Produto.fields.find(field => field.name === 'Preco').type, 'Decimal');
  assert.equal(collections.Pedido.fields.find(field => field.name === 'CriadoEm').type, 'DateTime');
});

test('6. effects per table 8.2, notCompiled empty; perturbation of product-form and checkout-form; catalog search', async () => {
  const { ir } = await capture();
  assert.deepEqual(ir.events.filter(event => !event.compiled).map(event => event.key), []);
  const expect = {
    'catalogo:click:category': ['setDimension'],
    'catalogo:click:clear-filters': ['setDimension', 'setDimension', 'setDimension', 'setDimension'],
    'catalogo:click:toggle-filters': ['setDimension'],
    'catalogo:click:product-detail': ['openPopup'],
    'catalogo:click:add': ['upsert', 'toast'],
    'detalhes-do-produto:click:add-modal': ['upsert', 'closePopup', 'toast'],
    'detalhes-do-produto:click:quantity-product': ['setDimension'],
    'entre-na-sua-conta:click:login': ['setDimension', 'closePopup'],
    'carrinho:click:quantity-cart': ['increment'],
    'carrinho:change:data-cart-quantity': ['update'],
    'carrinho:click:remove-cart': ['remove', 'toast'],
    'carrinho:submit:checkout-form': ['validate', 'insert', 'insertFrom', 'updateFrom', 'removeWhere', 'setDimension', 'navigate'],
    'meus-pedidos:click:customer-status-filter': ['setDimension'],
    'pedido:click:dismiss-success': ['setDimension'],
    'gestao-produtos:click:new-product': ['openPopup'],
    'gestao-produtos:click:edit-product': ['openPopup'],
    'gestao-produtos:click:toggle-product': ['toggle', 'toast'],
    'gestao-produtos:click:toggle-featured': ['toggle'],
    'gestao-pedidos:click:admin-status-filter': ['setDimension'],
    'gestao-pedidos:click:order-status': ['openPopup'],
    'atualizar-pedido:change:new-order-status': ['setDimension'],
    'atualizar-pedido:click:close-modal': ['closePopup'],
    'shell:click:fechar-notificacao': ['setDimension']
  };
  for (const [key, kinds] of Object.entries(expect)) {
    const event = findEvent(ir, key);
    assert.ok(event, 'missing event ' + key);
    assert.deepEqual(effectKinds(event), kinds, key);
  }
  // add: Visitante -> openPopup(EntreNaSuaConta); clients -> upsert by (ProdutoId, UserId).
  const add = findEvent(ir, 'catalogo:click:add');
  assert.deepEqual(add.cases.map(item => item.when), [{ op: 'eq', l: { dim: 'account-select' }, r: { lit: '0' } }]);
  assert.equal(add.cases[0].effects[0].modal, 'entre-na-sua-conta');
  assert.deepEqual(add.effects[0].keys, { ProdutoId: { param: 'Id' }, UserId: { dim: 'account-select' } });
  assert.deepEqual(findEvent(ir, 'detalhes-do-produto:click:add-modal').effects[0].by, { control: 'product-quantity' });
  // quantity-product: Max(1, Min(max, D + delta)).
  const quantity = findEvent(ir, 'detalhes-do-produto:click:quantity-product').effects[0];
  assert.equal(quantity.dimension, 'product-quantity');
  assert.deepEqual(quantity.value.add, [{ dim: 'product-quantity' }, { param: 'Delta' }]);
  assert.deepEqual(quantity.value.min, { lit: 1 });
  // account-select: navigate depends on the view and on the new value.
  const account = findEvent(ir, 'shell:change:account-select');
  assert.deepEqual(account.cases.map(item => item.when), [{ op: 'eq', l: { view: true }, r: { lit: 'catalogo' } }, { op: 'eq', l: { dim: 'account-select' }, r: { lit: '3' } }]);
  assert.equal(account.cases[1].effects.find(effect => effect.kind === 'navigate').view, 'gestao-produtos');
  assert.equal(account.effects.find(effect => effect.kind === 'navigate').view, 'catalogo');
  // product-form: insert (new, Id = 0) and update (edit, Id > 0) with every field bound to its control by name.
  const insert = findEvent(ir, 'novo-produto:submit:product-form').effects.find(effect => effect.kind === 'insert');
  const update = findEvent(ir, 'editar-produto:submit:product-form').effects.find(effect => effect.kind === 'update');
  for (const field of ['Nome', 'CategoriaId', 'Descricao', 'Preco', 'Estoque', 'ImagemUrl', 'Destaque', 'Ativo']) {
    assert.deepEqual(insert.fields[field], { control: field }, 'insert ' + field);
    assert.deepEqual(update.fields[field], { control: field }, 'update ' + field);
  }
  assert.deepEqual(insert.fields.Id, { key: 'max+1' });
  assert.deepEqual(update.key, { param: 'Id' });
  // checkout-form: validate (3-120, 10-500, <= 500, the exact model.js messages) and the composed writes.
  const checkout = findEvent(ir, 'carrinho:submit:checkout-form');
  const validate = checkout.effects[0];
  assert.deepEqual(validate.rules.map(rule => [rule.control, rule.when.op, rule.when.r.lit, rule.message]), [
    ['NomeDestinatario', 'len-ge', 3, 'Informe um nome de destinatario entre 3 e 120 caracteres.'],
    ['NomeDestinatario', 'len-le', 120, 'Informe um nome de destinatario entre 3 e 120 caracteres.'],
    ['EnderecoEntrega', 'len-ge', 10, 'Informe um endereco entre 10 e 500 caracteres.'],
    ['EnderecoEntrega', 'len-le', 500, 'Informe um endereco entre 10 e 500 caracteres.'],
    ['Observacao', 'len-le', 500, 'A observacao pode ter no maximo 500 caracteres.']
  ]);
  assert.deepEqual(validate.rules[0].target, { kind: 'alert', id: 'checkout-error' });
  const pedido = checkout.effects.find(effect => effect.kind === 'insert');
  assert.equal(pedido.collection, 'Pedido');
  assert.deepEqual(pedido.fields.UserId, { dim: 'account-select' });
  assert.deepEqual(pedido.fields.StatusPedidoId, { lit: 1 });
  assert.deepEqual(pedido.fields.CriadoEm, { clock: true });
  assert.deepEqual(pedido.fields.NomeDestinatario, { control: 'NomeDestinatario' });
  assert.equal(pedido.fields.Total.agg.op, 'sum');
  assert.deepEqual(pedido.fields.Total.agg.times, { collection: 'Produto', field: 'Preco', via: 'ProdutoId' });
  const items = checkout.effects.find(effect => effect.kind === 'insertFrom');
  assert.equal(items.collection, 'PedidoItem');
  assert.equal(items.from, 'CarrinhoItem');
  assert.deepEqual(items.where, { op: 'eq', l: { field: 'UserId' }, r: { dim: 'account-select' } });
  assert.deepEqual(items.fields.PedidoId, { inserted: 'Pedido' });
  assert.deepEqual(items.fields.Quantidade, { field: 'Quantidade' });
  assert.deepEqual(items.fields.NomeProduto, { field: 'Nome', via: 'ProdutoId', collection: 'Produto' });
  const stock = checkout.effects.find(effect => effect.kind === 'updateFrom');
  assert.deepEqual([stock.collection, stock.field, stock.from, stock.value, stock.sign], ['Produto', 'Estoque', 'CarrinhoItem', 'Quantidade', '-']);
  assert.equal(checkout.effects.find(effect => effect.kind === 'removeWhere').collection, 'CarrinhoItem');
  assert.deepEqual(checkout.effects.find(effect => effect.kind === 'navigate'), { kind: 'navigate', view: 'pedido', params: { Id: { inserted: 'Pedido' } } });
  assert.equal(checkout.effects.find(effect => effect.kind === 'setDimension').dimension, 'successId');
  // status-form: cancelling (new status = 4) also returns the stock.
  const status = findEvent(ir, 'atualizar-pedido:submit:status-form');
  assert.deepEqual(status.effects.map(effect => effect.kind), ['update', 'closePopup', 'toast']);
  assert.equal(status.cases[0].effects[0].kind, 'updateFrom');
  assert.equal(status.cases[0].effects[0].sign, '+');
  // catalog search: contains over the fields that react to the probe words.
  const grid = nodes(ir.views[0].root).find(node => node.list?.collection === 'Produto');
  const contains = JSON.stringify(grid.list.filter).includes('"op":"contains"');
  assert.ok(contains, JSON.stringify(grid.list.filter));
  const search = grid.list.filter.a.find(term => term.op === 'or' && term.a[1].op === 'contains');
  assert.deepEqual(search.a[1].fields, [{ field: 'Nome' }, { field: 'Descricao' }]);
  assert.deepEqual(search.a[1].r, { dim: 'catalog-search' });
});

test('7. catalog list: Produto filtered by Ativo (7 of 8), currency and cases formats, tile-N by substr-after; options by status', async () => {
  const { ir } = await capture();
  const grid = nodes(ir.views[0].root).find(node => node.list?.collection === 'Produto');
  assert.equal(grid.list.mode, 'self');
  assert.equal(grid.list.items, 7);
  assert.deepEqual(grid.list.filter.a[0], { op: 'truthy', l: { field: 'Ativo' } });
  assert.equal(grid.list.sortBy.dimension, 'catalog-sort');
  assert.deepEqual(grid.list.sortBy.cases.find(item => item.value === 'price-asc').sort, [{ field: 'Preco', dir: 'asc' }]);
  const template = nodes(grid.list.template);
  const price = template.find(node => node.expr?.fmt?.startsWith('currency'));
  assert.deepEqual(price.expr, { fmt: 'currency:pt-BR:BRL', value: { field: 'Preco' }, prefix: '', suffix: '', locale: 'pt-BR' });
  const stock = template.find(node => node.expr?.fmt === 'cases' && JSON.stringify(node.expr).includes('Últimas'));
  assert.deepEqual(stock.expr.cases.map(item => item.when), [{ op: 'eq', l: { field: 'Estoque' }, r: { lit: 0 } }, { op: 'le', l: { field: 'Estoque' }, r: { lit: 8 } }]);
  assert.deepEqual(stock.expr.cases[1].value, { fmt: 'integer', value: { field: 'Estoque' }, prefix: 'Últimas ', suffix: ' unidades', locale: 'pt-BR' });
  const tile = template.find(node => node.attrExpr?.class?.fmt === 'substr-after:#tile=');
  assert.deepEqual(tile.attrExpr.class, { fmt: 'substr-after:#tile=', value: { field: 'ImagemUrl' }, prefix: 'product-photo tile-', suffix: ' ', locale: 'pt-BR' });
  const feature = template.find(node => node.if?.op === 'truthy' && node.if.l.field === 'Destaque');
  assert.ok(feature, 'the feature tag only for Destaque');
  const select = nodes(ir.modals.find(modal => modal.key === 'atualizar-pedido').root).find(node => node.options?.by);
  assert.deepEqual(select.options.by, { field: 'StatusPedidoId' });
  assert.equal(select.options.entity, 'FarmaVirtualNewOrderStatusOpcao');
  assert.deepEqual(select.options.rows.map(row => [row.Chave, row.Value, row.Label]), [[1, '2', 'Em separação'], [1, '4', 'Cancelado'], [2, '3', 'Concluído'], [2, '4', 'Cancelado']]);
});

test('7b. modal and shell annotations: record fields and joins, pad, governing predicates, set-or-not dimensions, no nested If', async () => {
  const { ir } = await capture();
  const modal = key => nodes(ir.modals.find(item => item.key === key).root);
  const product = modal('detalhes-do-produto');
  const photo = product.find(node => node.attrExpr?.class?.fmt === 'substr-after:#tile=');
  assert.deepEqual(photo.attrExpr.class.value, { record: 'Produto', field: 'ImagemUrl' });
  assert.equal(photo.classExpr, undefined, 'tile-N is computed, not one predicate per token');
  const category = product.find(node => node.x !== undefined && node.expr?.value?.via === 'CategoriaId');
  assert.deepEqual(category.expr.value, { record: 'Produto', field: 'Nome', via: 'CategoriaId' }, 'the category name through the foreign key');
  const disabled = product.find(node => node.x !== undefined && JSON.stringify(node.expr ?? {}).includes('Somente consulta'));
  assert.deepEqual(disabled.expr.cases.map(item => item.when), [{ op: 'gt', l: { field: 'Estoque' }, r: { lit: 0 } }], 'Estoque governs the button, not CategoriaId');
  const code = modal('editar-produto').find(node => node.expr?.fmt?.startsWith('pad'));
  assert.deepEqual(code.expr, { fmt: 'pad:3:0', value: { record: 'Produto', field: 'Id' }, prefix: 'Produto #', suffix: '', locale: 'pt-BR' });
  const login = modal('entre-na-sua-conta').find(node => node.list);
  assert.equal(login.list.collection, 'Users');
  assert.deepEqual(login.list.filter, { op: 'eq', l: { field: 'Role' }, r: { lit: 'FarmaVirtual_Cliente' } });
  const toast = ir.shell.siblings[0].c[0];
  assert.deepEqual(toast.if, { op: 'ne', l: { dim: 'aviso' }, r: { lit: '' } }, 'the toast exists while Aviso is set');
  assert.ok(nodes(toast).some(node => node.expr?.value?.input === 'Aviso'));
  const search = nodes(ir.shell.root).find(node => node.t === 'input' && node.attrExpr?.value);
  assert.deepEqual(search.attrExpr.value, { fmt: 'text', value: { dim: 'catalog-search' }, prefix: '', suffix: '', locale: 'pt-BR' });
  const management = nodes(ir.views.find(view => view.key === 'gestao-produtos').root).find(node => node.x !== undefined && /^\d+ produtos$/.test(node.x.trim()));
  assert.equal(management.expr.fmt, 'integer', 'the empty state counts 0 rows: no case for the search probe');
  assert.ok(management.expr.value.count);
  const nested = [];
  const visit = (node, parentIf) => {
    if (!node || typeof node !== 'object') return;
    if (node.if && parentIf && JSON.stringify(node.if) === JSON.stringify(parentIf)) nested.push(node.k);
    for (const child of node.c ?? []) visit(child, node.if ?? null);
    if (node.list?.template) visit(node.list.template, null);
  };
  for (const root of [ir.shell.root, ...ir.shell.siblings, ...ir.views.map(view => view.root), ...ir.modals.map(item => item.root)]) visit(root, null);
  assert.deepEqual(nested, [], 'a child never repeats the condition of its parent');
});

test('8. determinism: the same sha256 with the same clock, with pool 8 and pool 1; timings, engine.node and source.root out of the hash; TZ pinned', async () => {
  const base = await capture();
  const again = await capturePrototype({ source, clock, pool: 8 });
  const single = await capturePrototype({ source, clock, pool: 1 });
  assert.equal(again.sha256, base.sha256);
  assert.equal(single.sha256, base.sha256);
  const copy = JSON.parse(JSON.stringify(base.ir));
  copy.timings = { totalMs: 1 };
  copy.engine.node = 'v0.0.0';
  copy.source.root = 'C:\\elsewhere';
  assert.equal(irHash(copy), base.sha256);
  copy.clock = '2026-10-11T00:00:00Z';
  assert.notEqual(irHash(copy), base.sha256);
  // TZ pinned in the children: order dates are formatted in the requested zone.
  const tokyo = await capturePrototype({ source, clock, pool: 8, tz: 'Asia/Tokyo' });
  const dates = ir => { const out = new Set(); for (const tree of Object.values(ir.trees)) walk(tree, node => { if (typeof node.x === 'string' && /\d{2} de [a-z]{3}\. de 2026/.test(node.x)) out.add(node.x.match(/\d{2} de [a-z]{3}\. de 2026/)[0]); }); return [...out].sort(); };
  assert.equal(tokyo.ir.tz, 'Asia/Tokyo');
  assert.ok(dates(base.ir).includes('09 de out. de 2026'), JSON.stringify(dates(base.ir)));
  assert.ok(!dates(tokyo.ir).includes('09 de out. de 2026'), JSON.stringify(dates(tokyo.ir)));
  assert.ok(dates(tokyo.ir).includes('08 de out. de 2026'), JSON.stringify(dates(tokyo.ir)));
  assert.notEqual(tokyo.sha256, base.sha256);
  // The bundle is content-addressed and verifiable.
  const verified = verifyBundle(base.capturePath);
  assert.deepEqual(verified.problems, []);
  assert.ok(base.ir.css.sheets[0].bundle.startsWith('sheets/'));
  assert.equal(base.ir.assets[0].path, 'assets/products.png');
});

test('12. FarmaVirtual capture <= 5 s with pool 8 (resident children) and <= 25 s with pool 1; probes and windows reported', async () => {
  await capture();
  // The machine is shared: the best of two warm captures (the children are resident, as in the long-lived facade).
  const times = [];
  let warm = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    warm = await capturePrototype({ source, clock, pool: 8 });
    times.push(Math.round(performance.now() - started));
    assert.equal(warm.ok, true);
  }
  assert.ok(warm.summary.probes > 0 && warm.summary.windows > 0 && warm.summary.pool === 8, JSON.stringify(warm.summary));
  assert.ok(Math.min(...times) <= 5000, 'pool 8 captures took ' + times.join(' / ') + ' ms (' + JSON.stringify(warm.ir.timings) + ')');
  const startedSingle = performance.now();
  const single = await capturePrototype({ source, clock, pool: 1 });
  const msSingle = performance.now() - startedSingle;
  assert.equal(single.summary.pool, 1);
  assert.ok(msSingle <= 25000, 'pool 1 capture took ' + Math.round(msSingle) + ' ms');
});

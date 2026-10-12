(function () {
  'use strict';
  let storage;
  try { storage = window.localStorage; } catch (_) { storage = null; }
  const model = FarmaModel.create(storage);
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const ui = {
    filter: { Busca: '', CategoriaId: 0, ApenasDisponiveis: false },
    sort: 'featured', managementSearch: '', managementCategory: 0, managementActive: 'all',
    orderStatus: 0, customerStatus: 0, filtersOpen: false, successId: null,
    delivery: { NomeDestinatario: '', EnderecoEntrega: '', Observacao: '' }
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<i data-lucide="${name}" class="icon" aria-hidden="true"></i>`;
  const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  const date = value => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
  const time = value => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const actor = () => model.currentUser();
  const isAdmin = () => actor()?.Role === model.ROLES.ADMIN;
  const isClient = () => actor()?.Role === model.ROLES.CLIENTE;
  const categoryName = id => model.Categorias().find(c => c.Id === id)?.Nome || '';
  const statusNames = { 1: 'Recebido', 2: 'Em separação', 3: 'Concluído', 4: 'Cancelado' };
  const statusBadge = id => `<span class="badge status-${id}">${statusNames[id]}</span>`;
  const route = () => (location.hash.slice(1) || 'catalogo').split('/');
  const btn = (text, name, attrs = '', type = '') => `<button class="btn ${type}" ${attrs}>${icon(name)}${text}</button>`;
  const empty = (name, title, message, action = '') => `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h2>${title}</h2><p>${message}</p>${action}</div>`;
  function image(url, name, extra = '') {
    const tile = String(url || '').match(/^assets\/products\.png#tile=([0-7])$/);
    if (tile) return `<div class="product-photo tile-${tile[1]} ${extra}" role="img" aria-label="${escape(name)}"></div>`;
    if (/^https?:\/\//i.test(url) || /^assets\/[\w./-]+$/.test(url)) return `<div class="product-photo no-image ${extra}"><img src="${escape(url)}" alt="${escape(name)}" loading="lazy"></div>`;
    return `<div class="product-photo no-image ${extra}" role="img" aria-label="Imagem indisponível">${icon('package')}</div>`;
  }
  function icons() { if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': 1.7 } }); }
  function cartQuantity() { return isClient() ? model.ObterCarrinho().QuantidadeTotal : 0; }
  function toast(message, error = false) {
    const el = document.createElement('div');
    el.className = `toast ${error ? 'error' : ''}`;
    el.innerHTML = `${icon(error ? 'circle-alert' : 'circle-check')}<span>${escape(message)}</span><button aria-label="Fechar notificação">${icon('x')}</button>`;
    el.querySelector('button').onclick = () => el.remove();
    document.getElementById('notifications').appendChild(el);
    icons();
    setTimeout(() => el.remove(), 5500);
  }
  function navLink(href, label, name, active) { return `<a class="nav-link ${active ? 'active' : ''}" href="#${href}" ${active ? 'aria-current="page"' : ''}>${icon(name)}${label}</a>`; }
  function shell(content, current) {
    const user = actor();
    const initials = user ? user.Name.split(' ').map(p => p[0]).join('') : 'V';
    return `<div class="demo-strip">${icon('info')}Ambiente de demonstração · Sem pagamento ou entrega real</div>
      <header class="site-header"><div class="container header-inner">
        <a class="brand" href="#catalogo" aria-label="FarmaVirtual, catálogo"><span class="brand-mark">${icon('plus')}</span><div>Farma<span>Virtual</span></div></a>
        <form class="search-header" id="header-search" role="search">${icon('search')}<input id="catalog-search" type="search" placeholder="O que você está procurando?" aria-label="Buscar produtos" value="${escape(ui.filter.Busca)}"></form>
        <div class="header-links">
          ${isClient() ? `<a class="header-link orders-link" href="#meus-pedidos">${icon('package')}<span>Meus pedidos</span></a><a class="header-link" href="#carrinho"><div class="cart-icon">${icon('shopping-bag')}<span class="cart-number" id="cart-count">${cartQuantity()}</span></div><span>Carrinho</span></a>` : ''}
          <div class="account"><span class="avatar">${initials}</span><div class="account-text"><small>${isAdmin() ? 'Administrador' : isClient() ? 'Olá, ' + escape(user.Name.split(' ')[0]) : 'Minha conta'}</small>
          <select id="account-select" aria-label="Conta de demonstração"><option value="0" ${!user ? 'selected' : ''}>Visitante</option>${model.Users.map(u => `<option value="${u.Id}" ${u.Id === user?.Id ? 'selected' : ''}>${u.Name}${u.Role === model.ROLES.ADMIN ? ' · Admin' : ''}</option>`).join('')}</select></div></div>
        </div>
      </div></header>
      <nav class="main-nav" aria-label="Navegação principal"><div class="container nav-inner">
        ${navLink('catalogo', 'Catálogo', 'grid-2x2', current === 'catalogo')}
        ${isClient() ? navLink('carrinho', 'Meu carrinho', 'shopping-bag', current === 'carrinho') + navLink('meus-pedidos', 'Meus pedidos', 'package', current === 'meus-pedidos' || current === 'pedido') : ''}
        ${isAdmin() ? `<div class="nav-management">${navLink('gestao-produtos', 'Gestão de produtos', 'boxes', current === 'gestao-produtos')}${navLink('gestao-pedidos', 'Gestão de pedidos', 'clipboard-list', current === 'gestao-pedidos' || current === 'pedido')}</div>` : ''}
      </div></nav>
      <main class="container main" id="main-content">${content}</main>
      <footer class="site-footer"><div class="container footer-inner"><div><a href="#catalogo" class="footer-brand">${icon('plus')}FarmaVirtual</a><p>Higiene, beleza e bem-estar. Cuidado em cada escolha.</p></div><span class="footer-status">Loja demonstrativa · Todos os pedidos são simulados</span></div></footer>`;
  }
  function breadcrumbs(items) {
    return `<nav class="breadcrumbs" aria-label="Localização"><a href="#catalogo">${icon('house')}</a>${items.map(([label, path]) => `${icon('chevron-right')}${path ? `<a href="#${path}">${label}</a>` : `<span aria-current="page">${label}</span>`}`).join('')}</nav>`;
  }
  function heading(title, subtitle, aside = '', eyebrow = '') {
    return `<div class="page-heading"><div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1><p>${subtitle}</p></div>${aside}</div>`;
  }
  function productCard(p) {
    const soldOut = p.Estoque === 0;
    return `<article class="product-card" data-product-id="${p.Id}">
      <div class="product-image-wrap" data-action="product-detail" data-id="${p.Id}" tabindex="0" role="button" aria-label="Ver detalhes de ${escape(p.Nome)}">${p.Destaque ? '<span class="feature-tag">Seleção FarmaVirtual</span>' : ''}${image(p.ImagemUrl, p.Nome)}</div>
      <div class="product-copy"><span class="product-category">${escape(categoryName(p.CategoriaId))}</span><button class="product-title" data-action="product-detail" data-id="${p.Id}">${escape(p.Nome)}</button>
      <span class="stock-label ${soldOut ? 'out' : ''}">${icon(soldOut ? 'circle-minus' : 'circle-check')}${soldOut ? 'Indisponível no momento' : p.Estoque < 10 ? `Últimas ${p.Estoque} unidades` : 'Disponível em estoque'}</span>
      <div class="price">${money(p.Preco)}</div>${btn(soldOut ? 'Indisponível' : 'Adicionar', soldOut ? 'circle-minus' : 'shopping-bag', `data-action="add" data-id="${p.Id}" ${soldOut || isAdmin() ? 'disabled' : ''} ${isAdmin() ? 'title="Use uma conta de cliente para comprar"' : ''}`, soldOut ? 'secondary full' : 'full')}</div>
    </article>`;
  }
  function catalog() {
    let products = model.ListarProdutos(ui.filter);
    if (ui.sort === 'price-asc') products.sort((a, b) => a.Preco - b.Preco);
    if (ui.sort === 'price-desc') products.sort((a, b) => b.Preco - a.Preco);
    if (ui.sort === 'name') products.sort((a, b) => a.Nome.localeCompare(b.Nome, 'pt-BR'));
    const all = model.ListarProdutos();
    const categoryIcons = { 1: 'droplets', 2: 'sparkles', 3: 'leaf' };
    return breadcrumbs([['Catálogo']]) + heading('Cuidado para todos os dias', 'Encontre seus essenciais de higiene, beleza e bem-estar.', `<span class="subtle">${icon('leaf')} Seleção FarmaVirtual</span>`, 'Seu bem-estar, por perto') +
      `<div class="catalog-layout"><aside class="filters ${ui.filtersOpen ? 'open' : ''}" aria-label="Filtros do catálogo"><div class="filter-heading"><h2>Filtros</h2><button class="text-button" data-action="clear-filters">Limpar</button></div>
      <span class="filter-label">Categorias</span><div class="category-options"><button class="category-button ${!ui.filter.CategoriaId ? 'active' : ''}" data-action="category" data-id="0">${icon('grid-2x2')}Todos os produtos<small>${all.length}</small></button>
      ${model.Categorias().map(c => `<button class="category-button ${ui.filter.CategoriaId === c.Id ? 'active' : ''}" data-action="category" data-id="${c.Id}">${icon(categoryIcons[c.Id] || 'tag')}${escape(c.Nome)}<small>${all.filter(p => p.CategoriaId === c.Id).length}</small></button>`).join('')}</div>
      <div class="filter-section"><span class="filter-label">Disponibilidade</span><label class="checkbox-label"><input id="available-filter" type="checkbox" ${ui.filter.ApenasDisponiveis ? 'checked' : ''}>Apenas disponíveis</label></div>
      <div class="filter-note">${icon('shield-check')}<span>Escolhas para sua rotina de cuidado e bem-estar.</span></div></aside>
      <section aria-label="Produtos"><div class="catalog-toolbar"><span><strong>${products.length} produto${products.length === 1 ? '' : 's'}</strong>${ui.filter.Busca ? ` para “${escape(ui.filter.Busca)}”` : ' encontrados'}</span>
      ${btn('Filtros', 'sliders-horizontal', `data-action="toggle-filters" aria-expanded="${ui.filtersOpen}"`, 'secondary mobile-filter-toggle')}
      <label class="sort-control"><span>Ordenar por</span><select id="catalog-sort" aria-label="Ordenar produtos">${[['featured', 'Destaques'], ['price-asc', 'Menor preço'], ['price-desc', 'Maior preço'], ['name', 'Nome do produto']].map(([v, t]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
      ${products.length ? `<div class="product-grid">${products.map(productCard).join('')}</div><div class="catalog-bottom">${icon('check')}Você está vendo todos os ${products.length} produtos desta seleção</div>` : empty('search', 'Nenhum produto encontrado', 'Tente outra busca ou selecione uma categoria diferente.', btn('Limpar filtros', 'rotate-ccw', 'data-action="clear-filters"', 'secondary'))}</section></div>`;
  }
  function stepper(id, value, max, mode = 'cart') {
    return `<div class="stepper"><button type="button" data-action="quantity-${mode}" data-id="${id}" data-delta="-1" aria-label="Diminuir quantidade" ${value <= 1 ? 'disabled' : ''}>${icon('minus')}</button><input type="number" min="1" max="${Math.max(max, value)}" value="${value}" aria-label="Quantidade" ${mode === 'cart' ? `data-cart-quantity="${id}"` : 'id="product-quantity"'}><button type="button" data-action="quantity-${mode}" data-id="${id}" data-delta="1" aria-label="Aumentar quantidade" ${value >= max ? 'disabled' : ''}>${icon('plus')}</button></div>`;
  }
  function cart() {
    const summary = model.ObterCarrinho();
    const badStock = summary.Itens.some(i => i.Quantidade > i.EstoqueDisponivel);
    if (!summary.Itens.length) return breadcrumbs([['Meu carrinho']]) + heading('Meu carrinho', 'Seus próximos cuidados começam aqui.') + empty('shopping-bag', 'Seu carrinho está vazio', 'Escolha seus produtos favoritos e cuide da sua rotina.', '<a class="btn" href="#catalogo">' + icon('arrow-left') + 'Explorar catálogo</a>');
    return breadcrumbs([['Meu carrinho']]) + heading('Meu carrinho', 'Revise seus produtos e confirme seu pedido de demonstração.', '<a class="back-link" href="#catalogo">' + icon('arrow-left') + 'Continuar escolhendo</a>') +
      `<div class="split-layout"><div><section aria-label="Itens do carrinho"><div class="section-line"><h2>Seus produtos</h2><span class="subtle">${summary.QuantidadeTotal} unidades</span></div>
      ${summary.Itens.map(item => `<div class="cart-row" data-cart-item="${item.CarrinhoItemId}">${image(item.ImagemUrl, item.Nome)}<div><div class="item-name">${escape(item.Nome)}</div><div class="item-meta">${money(item.PrecoUnitario)} / unidade</div>${item.Quantidade > item.EstoqueDisponivel ? `<div class="cart-alert">${item.EstoqueDisponivel ? `Estoque disponível: ${item.EstoqueDisponivel}. Ajuste a quantidade.` : 'Produto indisponível. Remova para continuar.'}</div>` : ''}</div>${stepper(item.CarrinhoItemId, item.Quantidade, item.EstoqueDisponivel)}<span class="row-total">${money(item.Subtotal)}</span><button class="icon-btn danger" data-action="remove-cart" data-id="${item.CarrinhoItemId}" aria-label="Remover ${escape(item.Nome)}" title="Remover produto">${icon('trash-2')}</button></div>`).join('')}</section>
      <section class="section-spaced"><h2>Dados de entrega</h2><p>Endereço fictício para este pedido de demonstração.</p><form id="checkout-form"><div class="error-message" id="checkout-error" role="alert"></div><div class="fields">
        <label class="field"><span>Nome do destinatário</span><input id="delivery-name" name="NomeDestinatario" autocomplete="off" required minlength="3" maxlength="120" placeholder="Nome completo" value="${escape(ui.delivery.NomeDestinatario)}"></label>
        <label class="field"><span>Endereço de entrega</span><textarea id="delivery-address" name="EnderecoEntrega" required minlength="10" maxlength="500" placeholder="Rua, número, complemento, cidade e estado">${escape(ui.delivery.EnderecoEntrega)}</textarea></label>
        <label class="field"><span>Observação <span class="optional">(opcional)</span></span><textarea id="delivery-note" name="Observacao" maxlength="500" placeholder="Alguma informação adicional?">${escape(ui.delivery.Observacao)}</textarea></label></div></form></section></div>
      <aside class="summary-panel"><h2>Resumo do pedido</h2><div class="summary-row"><span>Produtos</span><b>${summary.Itens.length} itens</b></div><div class="summary-row"><span>Quantidade</span><b>${summary.QuantidadeTotal} unidades</b></div><div class="summary-total"><span>Total</span><strong>${money(summary.Total)}</strong></div>
      ${btn('Confirmar pedido simulado', 'arrow-right', `type="submit" form="checkout-form" id="confirm-order" ${badStock ? 'disabled' : ''}`, 'full')}
      <div class="notice">${icon('info')}<span>Pedido de demonstração: nenhum pagamento ou entrega será realizado.</span></div>${badStock ? '<div class="cart-alert">Revise os produtos indisponíveis antes de confirmar.</div>' : ''}</aside></div>`;
  }
  function tabs(selected, counts, management = false) {
    return `<div class="filter-tabs" role="group" aria-label="Filtrar pedidos por status">${[[0, 'Todos'], ...model.Status().map(s => [s.Id, statusNames[s.Id]])].map(([id, name]) => `<button class="filter-tab ${selected === id ? 'active' : ''}" data-action="${management ? 'admin-status-filter' : 'customer-status-filter'}" data-id="${id}" aria-pressed="${selected === id}">${name}<small>${counts.filter(p => !id || p.StatusPedidoId === id).length}</small></button>`).join('')}</div>`;
  }
  function ordersTable(orders, management) {
    return `<div class="table-frame"><div class="table-scroll"><table class="data-table"><thead><tr><th>Pedido</th>${management ? '<th>Cliente</th>' : ''}<th>Data</th><th>Itens</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
      ${orders.map(order => { const details = model.ObterPedidoDetalhe(order.Id); return `<tr><td><a class="table-id" href="#pedido/${order.Id}">#${order.Id}</a></td>${management ? `<td>${escape(model.Users.find(u => u.Id === order.UserId)?.Name || '')}</td>` : ''}<td class="muted-cell">${date(order.CriadoEm)}</td><td class="muted-cell">${details.Itens.reduce((n, i) => n + i.Quantidade, 0)} unidades</td><td><strong>${money(order.Total)}</strong></td><td>${statusBadge(order.StatusPedidoId)}</td><td><div class="table-actions"><a class="icon-btn" href="#pedido/${order.Id}" title="Ver detalhes" aria-label="Ver pedido ${order.Id}">${icon('arrow-up-right')}</a>${management && order.StatusPedidoId < 3 ? `<button class="icon-btn" data-action="order-status" data-id="${order.Id}" title="Alterar status" aria-label="Alterar status do pedido ${order.Id}">${icon('square-pen')}</button>` : ''}</div></td></tr>`; }).join('')}
      </tbody></table></div><div class="table-footer"><span>${orders.length} pedido${orders.length === 1 ? '' : 's'}</span><span>Pedidos de demonstração</span></div></div>`;
  }
  function myOrders() {
    const all = model.ListarMeusPedidos();
    const filtered = all.filter(p => !ui.customerStatus || p.StatusPedidoId === ui.customerStatus);
    return breadcrumbs([['Meus pedidos']]) + heading('Meus pedidos', 'Acompanhe os produtos que fazem parte da sua rotina.', '<a class="btn secondary" href="#catalogo">' + icon('shopping-bag') + 'Explorar catálogo</a>') +
      `<div class="management-toolbar">${tabs(ui.customerStatus, all)}<span class="subtle">${all.length} pedidos no seu histórico</span></div>` +
      (filtered.length ? ordersTable(filtered, false) : empty('package-open', 'Nenhum pedido por aqui', ui.customerStatus ? 'Você não tem pedidos com este status.' : 'Seu primeiro pedido está a uma escolha de distância.', '<a class="btn" href="#catalogo">' + icon('shopping-bag') + 'Ver produtos</a>'));
  }
  function detail(id) {
    const { Pedido: order, Itens: items } = model.ObterPedidoDetalhe(id);
    const step = order.StatusPedidoId;
    const iconsList = ['clipboard-check', 'package', 'circle-check'];
    const back = isAdmin() ? 'gestao-pedidos' : 'meus-pedidos';
    return breadcrumbs([[isAdmin() ? 'Gestão de pedidos' : 'Meus pedidos', back], [`Pedido #${order.Id}`]]) +
      `${ui.successId === order.Id ? `<div class="success-banner">${icon('circle-check')}<div><h3>Seu pedido foi registrado!</h3><p>Esta é uma demonstração. Nenhum pagamento ou entrega será realizado.</p></div><button class="icon-btn" data-action="dismiss-success" aria-label="Fechar confirmação">${icon('x')}</button></div>` : ''}
      <div class="page-heading detail-heading"><div><span class="eyebrow">${isAdmin() ? 'Gestão de pedidos' : 'Meus pedidos'}</span><h1>Pedido #${order.Id}</h1><div class="detail-meta"><span>${date(order.CriadoEm)} às ${time(order.CriadoEm)}</span><span>·</span>${statusBadge(step)}</div></div>${isAdmin() && step < 3 ? btn('Alterar status', 'square-pen', `data-action="order-status" data-id="${order.Id}"`, 'secondary') : `<a class="back-link" href="#${back}">${icon('arrow-left')}Voltar aos pedidos</a>`}</div>
      <div class="split-layout"><div><section><div class="section-line"><h2>Acompanhamento do pedido</h2></div>
      ${step === 4 ? `<div class="cancel-message">${statusBadge(4)}<p style="margin-top:13px">Este pedido foi cancelado. Os produtos foram devolvidos ao estoque.</p></div>` : `<div class="timeline">${[1, 2, 3].map((s, index) => `<div class="timeline-step ${s < step ? 'done' : ''} ${s === step ? 'current' : ''}"><span class="timeline-marker">${icon(s < step ? 'check' : iconsList[index])}</span><span>${statusNames[s]}</span></div>`).join('')}</div>`}</section>
      <section class="section-spaced"><div class="section-line"><h2>Produtos do pedido</h2><span class="subtle">${items.length} itens</span></div>${items.map(item => {
        let p; try { p = model.ObterProduto(item.ProdutoId); } catch (_) { p = {}; }
        return `<div class="cart-row detail-item-row">${image(p.ImagemUrl, item.NomeProduto)}<div><div class="item-name">${escape(item.NomeProduto)}</div><div class="item-meta">${money(item.PrecoUnitario)} / unidade</div></div><span class="subtle">Qtd. ${item.Quantidade}</span><strong class="row-total">${money(item.Subtotal)}</strong></div>`;
      }).join('')}</section>
      <section class="address-detail"><div><h3>${icon('map-pin')}Dados de entrega</h3><p><strong>${escape(order.NomeDestinatario)}</strong><br>${escape(order.EnderecoEntrega)}</p></div><div><h3>${icon('message-square')}Observação</h3><p>${escape(order.Observacao || 'Nenhuma observação informada.')}</p></div></section></div>
      <aside class="summary-panel"><h2>Resumo do pedido</h2><div class="summary-row"><span>Pedido</span><b>#${order.Id}</b></div><div class="summary-row"><span>Quantidade</span><b>${items.reduce((n, i) => n + i.Quantidade, 0)} unidades</b></div><div class="summary-row"><span>Status</span>${statusBadge(step)}</div><div class="summary-total"><span>Total</span><strong>${money(order.Total)}</strong></div><div class="notice">${icon('info')}<span>Pedido de demonstração: nenhum pagamento ou entrega será realizado.</span></div></aside></div>`;
  }
  function stats(values) {
    return `<div class="stats-band">${values.map(([name, value, label]) => `<div class="stat"><div class="stat-icon">${icon(name)}</div><div><strong class="stat-value">${value}</strong><span class="stat-label">${label}</span></div></div>`).join('')}</div>`;
  }
  function managementProducts() {
    const all = model.ListarProdutos({}, true);
    const filter = { Busca: ui.managementSearch, CategoriaId: ui.managementCategory };
    if (ui.managementActive !== 'all') filter.Ativo = ui.managementActive === 'active';
    const products = model.ListarProdutos(filter, true);
    return breadcrumbs([['Administração'], ['Gestão de produtos']]) + heading('Gestão de produtos', 'Mantenha seu catálogo, preços e estoque em dia.', btn('Novo produto', 'plus', 'data-action="new-product"'), 'Administração') +
      stats([['boxes', all.length, 'Produtos cadastrados'], ['circle-check', all.filter(p => p.Ativo).length, 'Produtos ativos'], ['triangle-alert', all.filter(p => p.Estoque > 0 && p.Estoque < 10).length, 'Com estoque baixo'], ['package-x', all.filter(p => !p.Estoque).length, 'Sem estoque']]) +
      `<div class="management-toolbar"><div class="management-filters"><label class="input-search">${icon('search')}<input id="management-search" type="search" placeholder="Buscar por nome do produto" aria-label="Buscar produto na gestão" value="${escape(ui.managementSearch)}"></label><select id="management-category" aria-label="Filtrar categoria"><option value="0">Todas as categorias</option>${model.Categorias().map(c => `<option value="${c.Id}" ${ui.managementCategory === c.Id ? 'selected' : ''}>${escape(c.Nome)}</option>`).join('')}</select><select id="management-active" aria-label="Filtrar situação">${[['all', 'Todas as situações'], ['active', 'Ativos'], ['inactive', 'Inativos']].map(([v, t]) => `<option value="${v}" ${ui.managementActive === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div><span class="subtle">${products.length} produtos</span></div>
      ${products.length ? `<div class="table-frame"><div class="table-scroll"><table class="data-table"><thead><tr><th>Produto</th><th>Categoria</th><th>Preço</th><th>Estoque</th><th>Destaque</th><th>Ativo</th><th></th></tr></thead><tbody>${products.map(p => `<tr data-admin-product="${p.Id}"><td><div class="table-product">${image(p.ImagemUrl, p.Nome)}<div><strong>${escape(p.Nome)}</strong><small>#${String(p.Id).padStart(3, '0')}</small></div></div></td><td class="muted-cell">${escape(categoryName(p.CategoriaId))}</td><td><strong>${money(p.Preco)}</strong></td><td class="${p.Estoque === 0 ? 'zero-stock' : p.Estoque < 10 ? 'low-stock' : 'muted-cell'}">${p.Estoque} un.</td><td><button class="icon-btn" data-action="toggle-featured" data-id="${p.Id}" aria-label="${p.Destaque ? 'Remover' : 'Marcar'} destaque de ${escape(p.Nome)}" title="${p.Destaque ? 'Remover destaque' : 'Marcar como destaque'}" aria-pressed="${p.Destaque}" style="${p.Destaque ? 'color:#b49343' : ''}">${icon('star')}</button></td><td><button class="switch ${p.Ativo ? 'on' : ''}" role="switch" aria-checked="${p.Ativo}" data-action="toggle-product" data-id="${p.Id}" aria-label="Ativar ${escape(p.Nome)}" title="${p.Ativo ? 'Desativar produto' : 'Ativar produto'}"></button></td><td><button class="icon-btn" data-action="edit-product" data-id="${p.Id}" title="Editar produto" aria-label="Editar ${escape(p.Nome)}">${icon('square-pen')}</button></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${products.length} produtos encontrados</span><span>Catálogo FarmaVirtual</span></div></div>` : empty('search', 'Nenhum produto encontrado', 'Revise os filtros ou cadastre um novo produto.')}`;
  }
  function managementOrders() {
    const all = model.ListarPedidosGestao();
    const filtered = all.filter(p => !ui.orderStatus || p.StatusPedidoId === ui.orderStatus);
    return breadcrumbs([['Administração'], ['Gestão de pedidos']]) + heading('Gestão de pedidos', 'Acompanhe e organize os pedidos da FarmaVirtual.', '', 'Administração') +
      stats([['clipboard-list', all.length, 'Pedidos registrados'], ['clock-3', all.filter(p => p.StatusPedidoId === 1).length, 'Aguardando separação'], ['package', all.filter(p => p.StatusPedidoId === 2).length, 'Em separação'], ['circle-check', all.filter(p => p.StatusPedidoId === 3).length, 'Concluídos']]) +
      `<div class="management-toolbar">${tabs(ui.orderStatus, all, true)}<span class="subtle">${filtered.length} pedidos encontrados</span></div>` +
      (filtered.length ? ordersTable(filtered, true) : empty('package-open', 'Nenhum pedido com este status', 'Selecione outro status para consultar os pedidos.'));
  }
  function render() {
    const active = document.activeElement;
    const selection = active && active.selectionStart;
    const focusedId = active?.id;
    const [page, id] = route();
    let content;
    try {
      if (page.startsWith('gestao-') && !isAdmin()) throw new Error('Esta área é exclusiva de administradores.');
      if (['carrinho', 'meus-pedidos'].includes(page) && !isClient()) throw new Error('Selecione uma conta de cliente para acessar esta área.');
      if (page === 'catalogo') content = catalog();
      else if (page === 'carrinho') content = cart();
      else if (page === 'meus-pedidos') content = myOrders();
      else if (page === 'pedido') content = detail(id);
      else if (page === 'gestao-produtos') content = managementProducts();
      else if (page === 'gestao-pedidos') content = managementOrders();
      else content = empty('file-question', 'Página não encontrada', 'Retorne ao catálogo para continuar.', '<a class="btn" href="#catalogo">Ver catálogo</a>');
    } catch (error) { content = empty('shield-check', 'Acesso não disponível', escape(error.message), '<a class="btn" href="#catalogo">Voltar ao catálogo</a>'); }
    app.innerHTML = shell(content, page);
    icons();
    if (focusedId) {
      const next = document.getElementById(focusedId);
      if (next) { next.focus({ preventScroll: true }); try { next.setSelectionRange(selection, selection); } catch (_) { /* Non-text fields have no selection. */ } }
    }
  }
  function showModal(content, extraClass = '') {
    modal.className = extraClass;
    modal.innerHTML = content;
    icons();
    if (!modal.open) modal.showModal();
  }
  const modalHead = title => `<div class="modal-head"><h2 id="modal-title">${title}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></div>`;
  function openProduct(id) {
    const p = model.ObterProduto(id);
    showModal(modalHead('Detalhes do produto') + `<div class="modal-body"><div class="product-detail-grid">${image(p.ImagemUrl, p.Nome)}<div class="product-detail-copy"><span class="product-category">${escape(categoryName(p.CategoriaId))}</span><h2>${escape(p.Nome)}</h2><p>${escape(p.Descricao || 'Sem descrição adicional.')}</p><div class="price">${money(p.Preco)}</div><span class="stock-label ${p.Estoque ? '' : 'out'}">${icon(p.Estoque ? 'circle-check' : 'circle-minus')}${p.Estoque ? `${p.Estoque} unidades disponíveis` : 'Indisponível no momento'}</span>
      ${p.Estoque && !isAdmin() ? `<div class="product-add-row">${stepper(p.Id, 1, p.Estoque, 'product')}${btn('Adicionar', 'shopping-bag', `data-action="add-modal" data-id="${p.Id}"`)}</div>` : btn(p.Estoque ? 'Somente consulta' : 'Indisponível', 'package', 'disabled', 'secondary full')}</div></div></div>`, 'product-modal');
  }
  function openProductForm(id) {
    const p = id ? model.ObterProduto(id) : { Id: 0, CategoriaId: 1, Nome: '', Descricao: '', ImagemUrl: '', Preco: '', Estoque: 0, Destaque: false, Ativo: true };
    showModal(modalHead(id ? 'Editar produto' : 'Novo produto') + `<form id="product-form" data-id="${p.Id}"><div class="modal-body"><div class="error-message" id="product-error" role="alert"></div>
      ${id ? `<div class="form-preview">${image(p.ImagemUrl, p.Nome)}<div><h3>${escape(p.Nome)}</h3><p>Produto #${String(p.Id).padStart(3, '0')}</p></div></div>` : ''}<div class="fields">
      <label class="field"><span>Nome do produto</span><input name="Nome" required maxlength="120" value="${escape(p.Nome)}" placeholder="Nome e apresentação"></label>
      <label class="field"><span>Categoria</span><select name="CategoriaId" required>${model.Categorias().map(c => `<option value="${c.Id}" ${c.Id === p.CategoriaId ? 'selected' : ''}>${escape(c.Nome)}</option>`).join('')}</select></label>
      <label class="field"><span>Descrição</span><textarea name="Descricao" maxlength="2000" placeholder="Descrição do produto">${escape(p.Descricao)}</textarea></label>
      <div class="field-row"><label class="field"><span>Preço (R$)</span><input name="Preco" type="number" min="0.01" max="999999.99" step="0.01" required value="${p.Preco}" placeholder="0,00"></label><label class="field"><span>Estoque</span><input name="Estoque" type="number" min="0" step="1" required value="${p.Estoque}"></label></div>
      <label class="field"><span>URL da imagem <span class="optional">(opcional)</span></span><input name="ImagemUrl" value="${escape(p.ImagemUrl)}" placeholder="https://..."></label>
      <div class="modal-options"><label class="checkbox-label"><input type="checkbox" name="Destaque" ${p.Destaque ? 'checked' : ''}>Produto em destaque</label><label class="checkbox-label"><input type="checkbox" name="Ativo" ${p.Ativo ? 'checked' : ''}>Produto ativo</label></div></div></div>
      <div class="modal-foot">${btn('Cancelar', 'x', 'type="button" data-action="close-modal"', 'secondary')}${btn('Salvar produto', 'check', 'type="submit"')}</div></form>`);
  }
  function openStatus(id) {
    const { Pedido: p } = model.ObterPedidoDetalhe(id);
    const allowed = p.StatusPedidoId === 1 ? [2, 4] : p.StatusPedidoId === 2 ? [3, 4] : [];
    if (!allowed.length) { toast('Este pedido já está em um status final.', true); return; }
    showModal(modalHead(`Atualizar pedido #${p.Id}`) + `<form id="status-form" data-id="${p.Id}"><div class="modal-body"><div class="error-message" id="status-error" role="alert"></div><div class="summary-row" style="padding:0 0 22px"><span>Status atual</span>${statusBadge(p.StatusPedidoId)}</div><label class="field"><span>Novo status</span><select name="StatusPedidoId" id="new-order-status">${allowed.map(s => `<option value="${s}">${statusNames[s]}</option>`).join('')}</select></label><div class="notice" id="cancel-stock-notice" hidden>${icon('info')}Os produtos deste pedido serão devolvidos ao estoque. O cancelamento é definitivo.</div></div><div class="modal-foot">${btn('Voltar', 'arrow-left', 'type="button" data-action="close-modal"', 'secondary')}${btn('Confirmar alteração', 'check', 'type="submit" id="submit-status"')}</div></form>`);
  }
  function loginModal() {
    showModal(modalHead('Entre na sua conta') + `<div class="modal-body"><div class="fields">${model.Users.filter(u => u.Role === model.ROLES.CLIENTE).map(u => `<button class="btn secondary" data-action="login" data-id="${u.Id}">${icon('user-round')}${escape(u.Name)}</button>`).join('')}</div></div>`);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const id = Number(button.dataset.id);
    try {
      if (action === 'close-modal') { modal.close(); return; }
      if (action === 'login') { model.setUser(id); modal.close(); render(); return; }
      if (action === 'product-detail') { openProduct(id); return; }
      if (action === 'new-product' || action === 'edit-product') { openProductForm(action === 'new-product' ? 0 : id); return; }
      if (action === 'order-status') { openStatus(id); return; }
      if (action === 'category') ui.filter.CategoriaId = id;
      if (action === 'clear-filters') { ui.filter = { Busca: '', CategoriaId: 0, ApenasDisponiveis: false }; ui.sort = 'featured'; }
      if (action === 'toggle-filters') ui.filtersOpen = !ui.filtersOpen;
      if (action === 'add' || action === 'add-modal') {
        if (!actor()) { loginModal(); return; }
        const quantity = action === 'add-modal' ? Number(document.getElementById('product-quantity').value) : 1;
        model.AdicionarAoCarrinho(id, quantity);
        if (modal.open) modal.close();
        toast('Produto adicionado ao carrinho.');
      }
      if (action === 'quantity-product') {
        const field = document.getElementById('product-quantity');
        const next = Number(field.value) + Number(button.dataset.delta);
        const p = model.ObterProduto(id);
        if (next >= 1 && next <= p.Estoque) field.value = next;
        const step = field.closest('.stepper');
        step.querySelector('[data-delta="-1"]').disabled = Number(field.value) <= 1;
        step.querySelector('[data-delta="1"]').disabled = Number(field.value) >= p.Estoque;
        return;
      }
      if (action === 'quantity-cart') {
        const item = model.ObterCarrinho().Itens.find(i => i.CarrinhoItemId === id);
        model.AtualizarQuantidadeCarrinho(id, item.Quantidade + Number(button.dataset.delta));
      }
      if (action === 'remove-cart') { model.RemoverDoCarrinho(id); toast('Produto removido do carrinho.'); }
      if (action === 'customer-status-filter') ui.customerStatus = id;
      if (action === 'admin-status-filter') ui.orderStatus = id;
      if (action === 'toggle-product' || action === 'toggle-featured') {
        const p = model.ObterProduto(id);
        if (action === 'toggle-product') { p.Ativo = !p.Ativo; toast(p.Ativo ? 'Produto ativado.' : 'Produto desativado.'); }
        else p.Destaque = !p.Destaque;
        model.SalvarProduto(p);
      }
      if (action === 'dismiss-success') ui.successId = null;
      render();
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('change', event => {
    const el = event.target;
    const renderFields = ['account-select', 'available-filter', 'catalog-sort', 'management-category', 'management-active', 'product-quantity', 'new-order-status'];
    if (!renderFields.includes(el.id) && !el.dataset.cartQuantity) return;
    try {
      if (el.id === 'account-select') {
        model.setUser(el.value); ui.delivery = { NomeDestinatario: '', EnderecoEntrega: '', Observacao: '' }; ui.successId = null;
        if (modal.open) modal.close();
        const [page] = route();
        if (page !== 'catalogo') location.hash = isAdmin() ? 'gestao-produtos' : 'catalogo';
      }
      if (el.id === 'available-filter') ui.filter.ApenasDisponiveis = el.checked;
      if (el.id === 'catalog-sort') ui.sort = el.value;
      if (el.id === 'management-category') ui.managementCategory = Number(el.value);
      if (el.id === 'management-active') ui.managementActive = el.value;
      if (el.dataset.cartQuantity) model.AtualizarQuantidadeCarrinho(Number(el.dataset.cartQuantity), Number(el.value));
      if (el.id === 'product-quantity') {
        const step = el.closest('.stepper');
        step.querySelector('[data-delta="-1"]').disabled = Number(el.value) <= 1;
        step.querySelector('[data-delta="1"]').disabled = Number(el.value) >= Number(el.max);
        return;
      }
      if (el.id === 'new-order-status') {
        const cancel = Number(el.value) === 4;
        document.getElementById('cancel-stock-notice').hidden = !cancel;
        document.getElementById('submit-status').classList.toggle('danger', cancel);
        return;
      }
      render();
    } catch (error) { toast(error.message, true); render(); }
  });
  document.addEventListener('input', event => {
    const el = event.target;
    if (el.form?.id === 'checkout-form') ui.delivery[el.name] = el.value;
    if (el.id === 'catalog-search') { ui.filter.Busca = el.value; if (route()[0] !== 'catalogo') location.hash = 'catalogo'; render(); }
    if (el.id === 'management-search') { ui.managementSearch = el.value; render(); }
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    event.preventDefault();
    if (form.id === 'header-search') { location.hash = 'catalogo'; render(); return; }
    try {
      if (form.id === 'checkout-form') {
        const id = model.CriarPedidoSimulado(Object.fromEntries(new FormData(form)));
        ui.successId = id;
        ui.delivery = { NomeDestinatario: '', EnderecoEntrega: '', Observacao: '' };
        location.hash = `pedido/${id}`;
      }
      if (form.id === 'product-form') {
        const record = Object.fromEntries(new FormData(form));
        record.Id = Number(form.dataset.id); record.Destaque = form.elements.Destaque.checked; record.Ativo = form.elements.Ativo.checked;
        model.SalvarProduto(record); modal.close(); render(); toast('Produto salvo com sucesso.');
      }
      if (form.id === 'status-form') {
        model.AlterarStatusPedido(Number(form.dataset.id), Number(form.elements.StatusPedidoId.value));
        modal.close(); render(); toast('Status do pedido atualizado.');
      }
    } catch (error) {
      const errorId = { 'checkout-form': 'checkout-error', 'product-form': 'product-error', 'status-form': 'status-error' }[form.id];
      if (errorId) document.getElementById(errorId).textContent = error.message; else toast(error.message, true);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.target.matches('.product-image-wrap') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
  });
  document.addEventListener('error', event => {
    if (event.target.tagName === 'IMG') { event.target.parentElement.innerHTML = icon('package'); icons(); }
  }, true);
  modal.addEventListener('click', event => {
    if (event.target === modal) { const r = modal.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close(); }
  });
  window.addEventListener('hashchange', () => { if (modal.open) modal.close(); render(); window.scrollTo(0, 0); });
  render();
})();

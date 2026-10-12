(function (root) {
  'use strict';
  const STORAGE_KEY = 'farmavirtual-prototype-v1';
  const ROLES = { CLIENTE: 'FarmaVirtual_Cliente', ADMIN: 'FarmaVirtual_Admin' };
  const STATUS = [
    { Id: 1, Label: 'Recebido', Order: 1 },
    { Id: 2, Label: 'EmSeparacao', Order: 2 },
    { Id: 3, Label: 'Concluido', Order: 3 },
    { Id: 4, Label: 'Cancelado', Order: 4 }
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const cents = value => Math.round(Number(value) * 100);
  const total = values => values.reduce((sum, value) => sum + cents(value), 0) / 100;
  const fail = message => { throw new Error(message); };
  function seed() {
    const now = new Date();
    const ago = days => new Date(now.getTime() - days * 86400000).toISOString();
    const products = [
      [1, 2, 'Hidratante facial 50 g', 'Hidratante facial de uso diário em embalagem de 50 g.', 49.9, 24, true, true],
      [2, 3, 'Protetor solar FPS 50 120 ml', 'Protetor solar FPS 50 em embalagem de 120 ml. Consulte as orientações do fabricante no rótulo.', 89.9, 18, true, true],
      [3, 1, 'Sabonete líquido 250 ml', 'Sabonete líquido para higiene diária em frasco com dosador de 250 ml.', 24.9, 42, true, true],
      [4, 2, 'Creme para mãos 75 g', 'Creme para os cuidados diários das mãos, em bisnaga de 75 g.', 19.9, 8, false, true],
      [5, 1, 'Shampoo suave 300 ml', 'Shampoo para higiene dos cabelos em frasco de 300 ml.', 32.9, 31, false, true],
      [6, 1, 'Fio dental 50 m', 'Fio dental para higiene bucal diária. Embalagem com 50 metros.', 12.9, 0, false, true],
      [7, 1, 'Sabonete vegetal 90 g', 'Sabonete vegetal em barra de 90 g para higiene pessoal.', 9.9, 56, false, true],
      [8, 1, 'Álcool em gel 70% 250 ml', 'Álcool em gel para higiene das mãos. Frasco com dosador de 250 ml.', 17.9, 12, false, false]
    ].map(([Id, CategoriaId, Nome, Descricao, Preco, Estoque, Destaque, Ativo]) => ({ Id, CategoriaId, Nome, Descricao, ImagemUrl: `assets/products.png#tile=${Id - 1}`, Preco, Estoque, Destaque, Ativo }));
    const orders = [
      { Id: 1004, UserId: 2, StatusPedidoId: 1, CriadoEm: ago(0.5), Total: 32.9, NomeDestinatario: 'Lucas Oliveira', EnderecoEntrega: 'Rua das Flores, 90, Centro, Campinas - SP', Observacao: '' },
      { Id: 1003, UserId: 1, StatusPedidoId: 1, CriadoEm: ago(1), Total: 109.8, NomeDestinatario: 'Marina Costa', EnderecoEntrega: 'Rua dos Jardins, 245, apto. 32, São Paulo - SP', Observacao: 'Portaria no térreo.' },
      { Id: 1002, UserId: 1, StatusPedidoId: 2, CriadoEm: ago(3), Total: 59.7, NomeDestinatario: 'Marina Costa', EnderecoEntrega: 'Rua dos Jardins, 245, apto. 32, São Paulo - SP', Observacao: '' },
      { Id: 1001, UserId: 1, StatusPedidoId: 3, CriadoEm: ago(8), Total: 82.8, NomeDestinatario: 'Marina Costa', EnderecoEntrega: 'Rua dos Jardins, 245, apto. 32, São Paulo - SP', Observacao: '' },
      { Id: 1000, UserId: 2, StatusPedidoId: 4, CriadoEm: ago(12), Total: 24.9, NomeDestinatario: 'Lucas Oliveira', EnderecoEntrega: 'Rua das Flores, 90, Centro, Campinas - SP', Observacao: '' }
    ];
    const lines = [[1004, 5, 1], [1003, 2, 1], [1003, 4, 1], [1002, 3, 2], [1002, 7, 1], [1001, 1, 1], [1001, 5, 1], [1000, 3, 1]].map(([PedidoId, ProdutoId, Quantidade], i) => {
      const p = products.find(p => p.Id === ProdutoId);
      return { Id: i + 1, PedidoId, ProdutoId, NomeProduto: p.Nome, Quantidade, PrecoUnitario: p.Preco, Subtotal: cents(p.Preco) * Quantidade / 100 };
    });
    return {
      Categoria: [{ Id: 1, Nome: 'Higiene', Ativa: true }, { Id: 2, Nome: 'Beleza', Ativa: true }, { Id: 3, Nome: 'Bem-estar', Ativa: true }],
      Produto: products,
      CarrinhoItem: [{ Id: 1, UserId: 1, ProdutoId: 1, Quantidade: 1 }, { Id: 2, UserId: 1, ProdutoId: 3, Quantidade: 2 }],
      Pedido: orders,
      PedidoItem: lines,
      StatusPedido: clone(STATUS)
    };
  }
  const USERS = [
    { Id: 1, Name: 'Marina Costa', Username: 'marina.costa', Role: ROLES.CLIENTE },
    { Id: 2, Name: 'Lucas Oliveira', Username: 'lucas.oliveira', Role: ROLES.CLIENTE },
    { Id: 3, Name: 'Rafael Lima', Username: 'rafael.lima', Role: ROLES.ADMIN }
  ];
  function create(storage) {
    let db = seed();
    let userId = 1;
    try { const saved = storage && storage.getItem(STORAGE_KEY); if (saved) db = JSON.parse(saved); } catch (_) { /* Storage can be disabled for file URLs. */ }
    function persist(next) {
      if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(next));
      db = next;
    }
    const user = () => USERS.find(u => u.Id === userId) || null;
    const login = () => user() || fail('Entre em uma conta para continuar.');
    const admin = () => login().Role === ROLES.ADMIN || fail('Esta operacao exige a permissao de administrador.');
    const customer = () => login().Role === ROLES.CLIENTE || fail('Use uma conta de cliente para manter um carrinho e fazer pedidos.');
    const product = id => db.Produto.find(p => p.Id === Number(id)) || fail('Produto nao encontrado.');
    const ownedCartItem = id => {
      customer();
      return db.CarrinhoItem.find(i => i.Id === Number(id) && i.UserId === userId) || fail('Item do carrinho nao encontrado.');
    };
    const positiveInteger = quantity => Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0 || fail('Informe uma quantidade inteira maior que zero.');
    const available = (p, quantity) => {
      if (!p.Ativo || !db.Categoria.some(c => c.Id === p.CategoriaId && c.Ativa)) fail('Este produto esta indisponivel.');
      positiveInteger(quantity);
      if (quantity > p.Estoque) fail(`Estoque insuficiente. Disponivel: ${p.Estoque} unidade(s).`);
    };
    const nextId = rows => Math.max(0, ...rows.map(row => row.Id)) + 1;
    const api = {
      ROLES, Users: clone(USERS),
      currentUser: user,
      setUser(id) { userId = Number(id); return user(); },
      Categorias() { return clone(db.Categoria.filter(c => c.Ativa)); },
      Status() { return clone(db.StatusPedido); },
      ListarProdutos(filtro = {}, gestao = false) {
        if (gestao) admin();
        const term = String(filtro.Busca || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const result = db.Produto.filter(p => (gestao || p.Ativo && db.Categoria.some(c => c.Id === p.CategoriaId && c.Ativa)) && (!filtro.CategoriaId || p.CategoriaId === Number(filtro.CategoriaId)) && (!filtro.ApenasDisponiveis || p.Estoque > 0) && (gestao && filtro.Ativo !== undefined ? p.Ativo === filtro.Ativo : true) && `${p.Nome} ${p.Descricao}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(term));
        return clone(result.sort((a, b) => Number(b.Destaque) - Number(a.Destaque) || a.Id - b.Id));
      },
      ObterProduto(id) { const p = product(id); if (!p.Ativo && (!user() || user().Role !== ROLES.ADMIN)) fail('Produto indisponivel.'); return clone(p); },
      ObterCarrinho() {
        customer();
        const Itens = db.CarrinhoItem.filter(i => i.UserId === userId).map(i => {
          const p = product(i.ProdutoId);
          return { CarrinhoItemId: i.Id, ProdutoId: p.Id, Nome: p.Nome, ImagemUrl: p.ImagemUrl, Quantidade: i.Quantidade, PrecoUnitario: p.Preco, Subtotal: cents(p.Preco) * i.Quantidade / 100, EstoqueDisponivel: p.Ativo ? p.Estoque : 0 };
        });
        return { Itens, QuantidadeTotal: Itens.reduce((sum, i) => sum + i.Quantidade, 0), Total: total(Itens.map(i => i.Subtotal)) };
      },
      AdicionarAoCarrinho(produtoId, quantidade) {
        customer(); positiveInteger(quantidade);
        const p = product(produtoId);
        const existing = db.CarrinhoItem.find(i => i.UserId === userId && i.ProdutoId === p.Id);
        const quantity = Number(quantidade) + (existing ? existing.Quantidade : 0);
        available(p, quantity);
        const next = clone(db);
        if (existing) next.CarrinhoItem.find(i => i.Id === existing.Id).Quantidade = quantity;
        else next.CarrinhoItem.push({ Id: nextId(next.CarrinhoItem), UserId: userId, ProdutoId: p.Id, Quantidade: quantity });
        persist(next); return true;
      },
      AtualizarQuantidadeCarrinho(id, quantidade) {
        const item = ownedCartItem(id); available(product(item.ProdutoId), Number(quantidade));
        const next = clone(db); next.CarrinhoItem.find(i => i.Id === item.Id).Quantidade = Number(quantidade); persist(next); return true;
      },
      RemoverDoCarrinho(id) {
        const item = ownedCartItem(id); const next = clone(db); next.CarrinhoItem = next.CarrinhoItem.filter(i => i.Id !== item.Id); persist(next); return true;
      },
      CriarPedidoSimulado(entrega) {
        customer();
        const name = String(entrega.NomeDestinatario || '').trim();
        const address = String(entrega.EnderecoEntrega || '').trim();
        const note = String(entrega.Observacao || '').trim();
        if (name.length < 3 || name.length > 120) fail('Informe um nome de destinatario entre 3 e 120 caracteres.');
        if (address.length < 10 || address.length > 500) fail('Informe um endereco entre 10 e 500 caracteres.');
        if (note.length > 500) fail('A observacao pode ter no maximo 500 caracteres.');
        const cart = api.ObterCarrinho();
        if (!cart.Itens.length) fail('Adicione pelo menos um produto ao carrinho.');
        cart.Itens.forEach(i => available(product(i.ProdutoId), i.Quantidade));
        const next = clone(db);
        const id = Math.max(1000, nextId(next.Pedido));
        next.Pedido.push({ Id: id, UserId: userId, StatusPedidoId: 1, CriadoEm: new Date().toISOString(), Total: cart.Total, NomeDestinatario: name, EnderecoEntrega: address, Observacao: note });
        cart.Itens.forEach(item => {
          const p = next.Produto.find(p => p.Id === item.ProdutoId);
          next.PedidoItem.push({ Id: nextId(next.PedidoItem), PedidoId: id, ProdutoId: p.Id, NomeProduto: p.Nome, Quantidade: item.Quantidade, PrecoUnitario: p.Preco, Subtotal: item.Subtotal });
          p.Estoque -= item.Quantidade;
        });
        next.CarrinhoItem = next.CarrinhoItem.filter(i => i.UserId !== userId);
        persist(next); return id;
      },
      ListarMeusPedidos() { login(); return clone(db.Pedido.filter(p => p.UserId === userId).sort((a, b) => b.Id - a.Id)); },
      ObterPedidoDetalhe(id) {
        const actor = login(); const order = db.Pedido.find(p => p.Id === Number(id));
        if (!order || actor.Role !== ROLES.ADMIN && order.UserId !== userId) fail('Pedido nao encontrado ou acesso nao permitido.');
        return { Pedido: clone(order), Itens: clone(db.PedidoItem.filter(i => i.PedidoId === order.Id)) };
      },
      SalvarProduto(record) {
        admin();
        const nome = String(record.Nome || '').trim();
        const description = String(record.Descricao || '').trim();
        if (!nome || nome.length > 120) fail('Informe um nome de produto com ate 120 caracteres.');
        if (!db.Categoria.some(c => c.Id === Number(record.CategoriaId) && c.Ativa)) fail('Selecione uma categoria ativa.');
        if (!Number.isFinite(Number(record.Preco)) || Number(record.Preco) <= 0 || Number(record.Preco) > 999999.99) fail('Informe um preco maior que zero e de ate R$ 999.999,99.');
        if (!Number.isSafeInteger(Number(record.Estoque)) || Number(record.Estoque) < 0) fail('O estoque deve ser um numero inteiro igual ou maior que zero.');
        const url = String(record.ImagemUrl || '').trim();
        if (url && !/^assets\/[\w./-]+(?:#tile=[0-7])?$/.test(url) && !/^https?:\/\/[^\s<>"']+$/i.test(url)) fail('Informe uma URL HTTP(S) ou um caminho de imagem local valido.');
        if (description.length > 2000) fail('A descricao pode ter no maximo 2000 caracteres.');
        const id = record.Id ? product(record.Id).Id : nextId(db.Produto);
        const next = clone(db);
        const p = { Id: id, CategoriaId: Number(record.CategoriaId), Nome: nome, Descricao: description, ImagemUrl: url, Preco: cents(record.Preco) / 100, Estoque: Number(record.Estoque), Destaque: Boolean(record.Destaque), Ativo: Boolean(record.Ativo) };
        const index = next.Produto.findIndex(p => p.Id === id);
        if (index < 0) next.Produto.push(p); else next.Produto[index] = p;
        persist(next); return id;
      },
      ListarPedidosGestao(statusId) { admin(); return clone(db.Pedido.filter(p => !statusId || p.StatusPedidoId === Number(statusId)).sort((a, b) => b.Id - a.Id)); },
      AlterarStatusPedido(id, statusId) {
        admin(); const order = db.Pedido.find(p => p.Id === Number(id));
        if (!order) fail('Pedido nao encontrado.');
        const target = Number(statusId);
        if (order.StatusPedidoId === target) return true;
        const allowed = { 1: [2, 4], 2: [3, 4], 3: [], 4: [] };
        if (!allowed[order.StatusPedidoId].includes(target)) fail('Esta mudanca de status nao e permitida.');
        const next = clone(db); next.Pedido.find(p => p.Id === order.Id).StatusPedidoId = target;
        if (target === 4) next.PedidoItem.filter(i => i.PedidoId === order.Id).forEach(i => { next.Produto.find(p => p.Id === i.ProdutoId).Estoque += i.Quantidade; });
        persist(next); return true;
      }
    };
    return api;
  }
  root.FarmaModel = { create, seed, ROLES, STORAGE_KEY };
  if (typeof module !== 'undefined') module.exports = root.FarmaModel;
})(typeof window !== 'undefined' ? window : globalThis);

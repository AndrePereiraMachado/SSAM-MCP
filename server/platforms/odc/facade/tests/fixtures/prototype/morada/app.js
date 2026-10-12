/* Morada: comportamento do protótipo. Roteador por hash, telas como seções do index.html,
   modais <dialog> fixos e ações por data-action. Sem bibliotecas externas. */
(function () {
  'use strict';
  const D = window.MoradaData;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const dataBr = iso => iso ? iso.split('-').reverse().join('/') : '';
  const hoje = () => new Date().toISOString().slice(0, 10);
  const campo = (form, nome) => form.elements.namedItem(nome);

  const state = {
    filtro: { cidade: '', tipo: '', quartos: 0, precoMax: 0, mobiliado: false, pets: false },
    ordem: 'relevancia',
    imovelAtual: null,
    confirmar: null
  };

  const usuario = () => D.usuarios.find(u => u.id === D.usuarioAtualId) || null;
  const imovel = id => D.imoveis.find(i => i.id === Number(id));
  const nomeUsuario = id => (D.usuarios.find(u => u.id === id) || {}).nome || '—';
  const total = i => i.aluguel + i.condominio + i.iptu;

  const statusRotulo = { pendente: 'Pendente', aceita: 'Aceita', recusada: 'Recusada', cancelada: 'Cancelada', ativo: 'Ativo', pausado: 'Pausado' };
  const badge = s => `<span class="badge st-${esc(s)}">${esc(statusRotulo[s] || s)}</span>`;

  /* ---------- notificações ---------- */
  function avisar(texto, erro) {
    const el = document.createElement('div');
    el.className = 'toast' + (erro ? ' error' : '');
    el.innerHTML = `<span>${esc(texto)}</span><button type="button" class="toast-close" data-action="close-toast" aria-label="Fechar aviso">×</button>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  /* ---------- roteador ---------- */
  function rota() {
    const partes = (location.hash.replace(/^#\/?/, '') || 'buscar').split('/');
    return { tela: partes[0], id: partes[1] };
  }

  function mostrar() {
    const r = rota();
    const telas = ['buscar', 'imovel', 'favoritos', 'propostas', 'anunciar', 'painel'];
    const tela = telas.includes(r.tela) ? r.tela : 'buscar';
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== tela; });
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === tela));
    if ((tela === 'propostas' || tela === 'painel') && !usuario()) {
      abrir('#dlg-login');
    }
    if (tela === 'buscar') renderBusca();
    if (tela === 'imovel') renderImovel(r.id);
    if (tela === 'favoritos') renderFavoritos();
    if (tela === 'propostas') renderPropostas();
    if (tela === 'anunciar') prepararAnuncio();
    if (tela === 'painel') renderPainel();
    window.scrollTo(0, 0);
  }

  /* ---------- cabeçalho ---------- */
  function renderConta() {
    const u = usuario();
    $('#user-name').textContent = u ? u.nome : 'Visitante';
    $('#btn-login').hidden = !!u;
    $('#btn-logout').hidden = !u;
    $('#fav-count').textContent = String(D.favoritos.size);
  }

  /* ---------- busca ---------- */
  function filtrar() {
    const f = state.filtro;
    let lista = D.imoveis.filter(i => i.status === 'ativo'
      && (!f.cidade || i.cidade === f.cidade)
      && (!f.tipo || i.tipo === f.tipo)
      && i.quartos >= f.quartos
      && (!f.precoMax || i.aluguel <= f.precoMax)
      && (!f.mobiliado || i.mobiliado)
      && (!f.pets || i.pets));
    if (state.ordem === 'menor') lista = lista.slice().sort((a, b) => a.aluguel - b.aluguel);
    if (state.ordem === 'maior') lista = lista.slice().sort((a, b) => b.aluguel - a.aluguel);
    if (state.ordem === 'area') lista = lista.slice().sort((a, b) => b.area - a.area);
    if (state.ordem === 'relevancia') lista = lista.slice().sort((a, b) => b.visualizacoes - a.visualizacoes);
    return lista;
  }

  function linhaImovel(i) {
    const fav = D.favoritos.has(i.id);
    return `<li class="listing-row">
      <a class="thumb" href="#/imovel/${i.id}"><img src="${esc(i.fotos[0])}" alt="${esc(i.titulo)}"></a>
      <div class="listing-body">
        <a class="listing-title" href="#/imovel/${i.id}">${esc(i.titulo)}</a>
        <p class="muted">${esc(i.bairro)}, ${esc(i.cidade)} · ${esc(i.tipo)}</p>
        <ul class="facts">
          <li>${i.quartos} ${i.quartos === 1 ? 'quarto' : 'quartos'}</li>
          <li>${i.banheiros} ${i.banheiros === 1 ? 'banheiro' : 'banheiros'}</li>
          <li>${i.vagas} ${i.vagas === 1 ? 'vaga' : 'vagas'}</li>
          <li>${i.area} m²</li>
          ${i.mobiliado ? '<li>Mobiliado</li>' : ''}
          ${i.pets ? '<li>Aceita pets</li>' : ''}
        </ul>
      </div>
      <div class="listing-price">
        <p class="price">${brl(i.aluguel)}<span class="per">/mês</span></p>
        <p class="muted small">Total ${brl(total(i))}</p>
        <button type="button" class="btn ghost fav-toggle${fav ? ' on' : ''}" data-action="toggle-fav" data-id="${i.id}" aria-pressed="${fav}">${fav ? 'Salvo' : 'Favoritar'}</button>
      </div>
    </li>`;
  }

  function renderBusca() {
    const lista = filtrar();
    $('#lista-imoveis').innerHTML = lista.map(linhaImovel).join('');
    $('#lista-vazia').hidden = lista.length > 0;
    $('#results-count').textContent = lista.length === 1 ? '1 imóvel' : `${lista.length} imóveis`;
  }

  /* ---------- detalhe ---------- */
  function renderImovel(id) {
    const i = imovel(id);
    if (!i) { location.hash = '#/buscar'; return; }
    state.imovelAtual = i;
    i.visualizacoes += 1;
    const bind = (nome, valor) => $$(`[data-view="imovel"] [data-bind="${nome}"]`).forEach(el => { el.textContent = valor; });
    bind('titulo', i.titulo);
    bind('endereco', `${i.endereco} · ${i.bairro}, ${i.cidade}`);
    bind('descricao', i.descricao);
    bind('aluguel', brl(i.aluguel));
    bind('condominio', brl(i.condominio));
    bind('iptu', brl(i.iptu));
    bind('total', brl(total(i)));
    bind('proprietario', nomeUsuario(i.proprietarioId));
    bind('resposta', i.proprietarioId === 2 ? '2 horas' : '1 dia');
    $('#foto-principal').src = i.fotos[0];
    $('#foto-principal').alt = i.titulo;
    $('#miniaturas').innerHTML = i.fotos.map((f, n) =>
      `<button type="button" class="thumb-btn${n === 0 ? ' on' : ''}" data-action="photo" data-src="${esc(f)}"><img src="${esc(f)}" alt="Foto ${n + 1}"></button>`).join('');
    $('#caracteristicas').innerHTML = [
      `${i.quartos} ${i.quartos === 1 ? 'quarto' : 'quartos'}`, `${i.banheiros} ${i.banheiros === 1 ? 'banheiro' : 'banheiros'}`,
      `${i.vagas} ${i.vagas === 1 ? 'vaga' : 'vagas'}`, `${i.area} m²`, i.mobiliado ? 'Mobiliado' : 'Sem mobília', i.pets ? 'Aceita pets' : 'Não aceita pets'
    ].map(t => `<li>${esc(t)}</li>`).join('');
    const fav = D.favoritos.has(i.id);
    const bf = $('#btn-fav-detalhe');
    bf.classList.toggle('on', fav);
    bf.setAttribute('aria-pressed', String(fav));
    bf.querySelector('span').textContent = fav ? 'Salvo nos favoritos' : 'Favoritar';
    bf.dataset.id = String(i.id);
  }

  /* ---------- favoritos ---------- */
  function renderFavoritos() {
    const lista = D.imoveis.filter(i => D.favoritos.has(i.id));
    $('#lista-favoritos').innerHTML = lista.map(linhaImovel).join('');
    $('#favoritos-vazio').hidden = lista.length > 0;
  }

  /* ---------- propostas (inquilino) ---------- */
  function renderPropostas() {
    const u = usuario();
    const minhas = u ? D.propostas.filter(p => p.inquilinoId === u.id) : [];
    $('#tabela-propostas').innerHTML = minhas.map(p => {
      const i = imovel(p.imovelId);
      return `<tr>
        <td><a href="#/imovel/${i.id}">${esc(i.titulo)}</a></td>
        <td>${brl(p.valor)}</td><td>${dataBr(p.inicio)}</td><td>${p.prazo} meses</td>
        <td>${badge(p.status)}</td><td>${dataBr(p.enviadaEm)}</td>
        <td class="row-actions">${p.status === 'pendente' ? `<button type="button" class="btn ghost small" data-action="cancel-proposal" data-id="${p.id}">Cancelar</button>` : ''}</td>
      </tr>`;
    }).join('');
    $('#propostas-vazio').hidden = minhas.length > 0;
  }

  /* ---------- anunciar ---------- */
  function prepararAnuncio() {
    if (!usuario()) abrir('#dlg-login');
    $('#anuncio-erro').hidden = true;
  }

  /* ---------- painel do proprietário ---------- */
  function renderPainel() {
    const u = usuario();
    const meus = u ? D.imoveis.filter(i => i.proprietarioId === u.id) : [];
    $('#tabela-anuncios').innerHTML = meus.map(i => {
      const qtd = D.propostas.filter(p => p.imovelId === i.id).length;
      return `<tr>
        <td><a href="#/imovel/${i.id}">${esc(i.titulo)}</a><br><span class="muted small">${esc(i.bairro)}, ${esc(i.cidade)}</span></td>
        <td>${brl(i.aluguel)}</td><td>${badge(i.status)}</td><td>${i.visualizacoes}</td><td>${qtd}</td>
        <td class="row-actions">
          <button type="button" class="btn ghost small" data-action="toggle-status" data-id="${i.id}">${i.status === 'ativo' ? 'Pausar' : 'Ativar'}</button>
          <button type="button" class="btn ghost small" data-action="edit-listing" data-id="${i.id}">Editar</button>
          <button type="button" class="btn ghost small danger-text" data-action="delete-listing" data-id="${i.id}">Excluir</button>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="6" class="muted">${u ? 'Você ainda não tem anúncios.' : 'Entre para ver seus anúncios.'}</td></tr>`;
    const ids = new Set(meus.map(i => i.id));
    const recebidas = D.propostas.filter(p => ids.has(p.imovelId));
    $('#tabela-recebidas').innerHTML = recebidas.map(p => `<tr>
        <td>${esc(imovel(p.imovelId).titulo)}</td><td>${esc(nomeUsuario(p.inquilinoId))}</td>
        <td>${brl(p.valor)}</td><td>${dataBr(p.inicio)}</td><td>${badge(p.status)}</td>
        <td class="row-actions">${p.status === 'pendente' ? `
          <button type="button" class="btn primary small" data-action="accept-proposal" data-id="${p.id}">Aceitar</button>
          <button type="button" class="btn ghost small" data-action="reject-proposal" data-id="${p.id}">Recusar</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhuma proposta recebida.</td></tr>';
  }

  /* ---------- modais ---------- */
  function abrir(sel) { const d = $(sel); if (d && !d.open) d.showModal(); }

  function preencherSelects() {
    const opcoesCidade = D.cidades.map(c => `<option>${esc(c)}</option>`).join('');
    $('#f-cidade').innerHTML = '<option value="">Todas</option>' + opcoesCidade;
    $('#a-cidade').innerHTML = opcoesCidade;
    $('#login-usuario').innerHTML = D.usuarios.map(u => `<option value="${u.id}">${esc(u.nome)} (${u.perfil === 'proprietario' ? 'proprietário' : 'inquilino'})</option>`).join('');
  }

  function exigirLogin() {
    if (usuario()) return true;
    abrir('#dlg-login');
    avisar('Entre com uma conta para continuar.', true);
    return false;
  }

  /* ---------- ações ---------- */
  const acoes = {
    'toggle-fav'(el) {
      const id = Number(el.dataset.id || (state.imovelAtual && state.imovelAtual.id));
      if (D.favoritos.has(id)) { D.favoritos.delete(id); avisar('Removido dos favoritos.'); }
      else { D.favoritos.add(id); avisar('Salvo nos favoritos.'); }
      renderConta(); mostrar();
    },
    photo(el) {
      $('#foto-principal').src = el.dataset.src;
      $$('#miniaturas .thumb-btn').forEach(b => b.classList.toggle('on', b === el));
    },
    'clear-filters'() {
      $('#filtros').reset();
      state.filtro = { cidade: '', tipo: '', quartos: 0, precoMax: 0, mobiliado: false, pets: false };
      renderBusca();
    },
    'open-login'() { abrir('#dlg-login'); },
    logout() { D.usuarioAtualId = null; renderConta(); avisar('Sessão encerrada.'); mostrar(); },
    'open-visita'() {
      if (!exigirLogin()) return;
      $('#dlg-visita [data-bind="titulo"]').textContent = state.imovelAtual.titulo;
      $('#dlg-visita form').reset();
      $('#dlg-visita [name="data"]').min = hoje();
      abrir('#dlg-visita');
    },
    'open-proposta'() {
      if (!exigirLogin()) return;
      const f = $('#dlg-proposta form');
      f.reset();
      $('#dlg-proposta [data-bind="titulo"]').textContent = state.imovelAtual.titulo;
      campo(f, 'valor').value = state.imovelAtual.aluguel;
      campo(f, 'inicio').min = hoje();
      abrir('#dlg-proposta');
    },
    'cancel-proposal'(el) {
      pedirConfirmacao('Cancelar esta proposta? O proprietário será avisado.', () => {
        const p = D.propostas.find(x => x.id === Number(el.dataset.id));
        p.status = 'cancelada'; avisar('Proposta cancelada.'); renderPropostas();
      });
    },
    'accept-proposal'(el) {
      const p = D.propostas.find(x => x.id === Number(el.dataset.id));
      p.status = 'aceita';
      D.propostas.filter(x => x.imovelId === p.imovelId && x.id !== p.id && x.status === 'pendente').forEach(x => { x.status = 'recusada'; });
      imovel(p.imovelId).status = 'pausado';
      avisar('Proposta aceita. O anúncio foi pausado.'); renderPainel();
    },
    'reject-proposal'(el) {
      const p = D.propostas.find(x => x.id === Number(el.dataset.id));
      p.status = 'recusada'; avisar('Proposta recusada.'); renderPainel();
    },
    'toggle-status'(el) {
      const i = imovel(el.dataset.id);
      i.status = i.status === 'ativo' ? 'pausado' : 'ativo';
      avisar(i.status === 'ativo' ? 'Anúncio ativado.' : 'Anúncio pausado.'); renderPainel();
    },
    'edit-listing'(el) {
      const i = imovel(el.dataset.id);
      const f = $('#dlg-editar form');
      campo(f, 'id').value = i.id; campo(f, 'titulo').value = i.titulo; campo(f, 'aluguel').value = i.aluguel; campo(f, 'status').value = i.status;
      abrir('#dlg-editar');
    },
    'delete-listing'(el) {
      const i = imovel(el.dataset.id);
      pedirConfirmacao(`Excluir o anúncio "${i.titulo}"? As propostas dele também serão removidas.`, () => {
        D.imoveis.splice(D.imoveis.indexOf(i), 1);
        for (let n = D.propostas.length - 1; n >= 0; n--) if (D.propostas[n].imovelId === i.id) D.propostas.splice(n, 1);
        D.favoritos.delete(i.id);
        avisar('Anúncio excluído.'); renderConta(); renderPainel();
      });
    },
    'close-toast'(el) { el.closest('.toast').remove(); }
  };

  function pedirConfirmacao(texto, aoConfirmar) {
    $('#confirmar-texto').textContent = texto;
    state.confirmar = aoConfirmar;
    abrir('#dlg-confirmar');
  }

  /* ---------- formulários ---------- */
  function aoEnviar(form) {
    const tipo = form.dataset.action;
    if (tipo === 'filter') {
      const f = new FormData(form);
      state.filtro = {
        cidade: f.get('cidade') || '', tipo: f.get('tipo') || '', quartos: Number(f.get('quartos') || 0),
        precoMax: Number(f.get('precoMax') || 0), mobiliado: f.get('mobiliado') === 'on', pets: f.get('pets') === 'on'
      };
      renderBusca();
      return;
    }
    if (tipo === 'publish') {
      if (!exigirLogin()) return;
      const erro = $('#anuncio-erro');
      if (!form.checkValidity()) { erro.textContent = 'Preencha os campos obrigatórios destacados.'; erro.hidden = false; form.classList.add('touched'); return; }
      const f = new FormData(form);
      const novo = {
        id: D.proximoId.imovel++, titulo: f.get('titulo'), tipo: f.get('tipo'), cidade: f.get('cidade'), bairro: f.get('bairro'),
        endereco: f.get('endereco'), quartos: Number(f.get('quartos')), banheiros: Number(f.get('banheiros')), vagas: Number(f.get('vagas') || 0),
        area: Number(f.get('area')), aluguel: Number(f.get('aluguel')), condominio: Number(f.get('condominio') || 0), iptu: Number(f.get('iptu') || 0),
        mobiliado: f.get('mobiliado') === 'on', pets: f.get('pets') === 'on', status: 'pausado', proprietarioId: usuario().id,
        visualizacoes: 0, fotos: [f.get('foto')], descricao: f.get('descricao')
      };
      D.imoveis.push(novo);
      form.reset(); form.classList.remove('touched'); erro.hidden = true;
      avisar('Anúncio salvo como pausado. Ative-o no painel.');
      location.hash = '#/painel';
    }
  }

  function aoFecharDialogo(dlg) {
    const form = dlg.querySelector('form');
    if (dlg.returnValue !== 'ok') return;
    const tipo = form.dataset.action;
    const f = new FormData(form);
    if (tipo === 'login') {
      D.usuarioAtualId = Number(f.get('usuario'));
      renderConta(); avisar(`Olá, ${usuario().nome.split(' ')[0]}.`); mostrar();
    }
    if (tipo === 'schedule') {
      D.visitas.push({ id: D.proximoId.visita++, imovelId: state.imovelAtual.id, inquilinoId: usuario().id, data: f.get('data'), horario: f.get('horario'), mensagem: f.get('mensagem') });
      avisar(`Visita agendada para ${dataBr(f.get('data'))} às ${f.get('horario')}.`);
    }
    if (tipo === 'propose') {
      D.propostas.push({ id: D.proximoId.proposta++, imovelId: state.imovelAtual.id, inquilinoId: usuario().id, valor: Number(f.get('valor')), inicio: f.get('inicio'), prazo: Number(f.get('prazo')), status: 'pendente', enviadaEm: hoje(), mensagem: f.get('mensagem') });
      avisar('Proposta enviada ao proprietário.');
    }
    if (tipo === 'save-listing') {
      const i = imovel(f.get('id'));
      i.titulo = f.get('titulo'); i.aluguel = Number(f.get('aluguel')); i.status = f.get('status');
      avisar('Anúncio atualizado.'); renderPainel();
    }
    if (tipo === 'confirm' && state.confirmar) { const fn = state.confirmar; state.confirmar = null; fn(); }
  }

  /* ---------- ligação de eventos ---------- */
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT') return;
    const fn = acoes[el.dataset.action];
    if (fn) { ev.preventDefault(); fn(el); }
  });
  document.addEventListener('change', ev => {
    if (ev.target.id === 'ordenar') { state.ordem = ev.target.value; renderBusca(); }
  });
  document.addEventListener('submit', ev => {
    const form = ev.target;
    if (form.method === 'dialog') return;
    ev.preventDefault();
    aoEnviar(form);
  });
  $$('dialog').forEach(d => d.addEventListener('close', () => aoFecharDialogo(d)));
  window.addEventListener('hashchange', mostrar);

  preencherSelects();
  renderConta();
  mostrar();
})();

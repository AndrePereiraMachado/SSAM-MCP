(function () {
  var db = Store.initial();
  var perfil = 'leitor';
  var app = document.getElementById('app');
  function shell(content, page) {
    return '<header class="topo"><span class="titulo">Painel Obras</span>' +
      '<span class="perfis"><button data-action="perfil" data-id="leitor" class="' + (perfil === 'leitor' ? 'ativo' : '') + '">Leitor</button><button data-action="perfil" data-id="admin" class="' + (perfil === 'admin' ? 'ativo' : '') + '">Admin</button></span></header>' +
      '<nav class="menu"><a href="#obras" class="' + (page === 'obras' ? 'ativo' : '') + '">Obras</a><a href="#relatorio" class="' + (page === 'relatorio' ? 'ativo' : '') + '">Relatorio</a><a href="#ajuda" class="' + (page === 'ajuda' ? 'ativo' : '') + '">Ajuda</a></nav>' +
      '<main class="conteudo">' + content + '</main>';
  }
  function obras() {
    return '<h1>Obras</h1><ul class="lista">' + db.Obra.map(function (obra) { return '<li class="item" data-id="' + obra.Id + '"><strong>' + obra.Nome + '</strong> <span class="etapa">' + obra.Etapa + '</span></li>'; }).join('') + '</ul>';
  }
  var negado = '<div class="vazio"><h1>Acesso nao disponivel</h1><p>Somente administradores.</p></div>';
  function relatorio() {
    if (perfil !== 'admin') return negado;
    return '<h1>Relatorio</h1><table class="tabela"><tr><th>Obras</th><td>' + db.Obra.length + '</td></tr></table>';
  }
  function render() {
    var page = (location.hash.slice(1) || 'obras');
    var content = page === 'relatorio' ? relatorio() : page === 'obras' ? obras() : negado;
    app.innerHTML = shell(content, page);
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action="perfil"]');
    if (button) { perfil = button.getAttribute('data-id'); render(); }
  });
  window.addEventListener('hashchange', render);
  render();
})();

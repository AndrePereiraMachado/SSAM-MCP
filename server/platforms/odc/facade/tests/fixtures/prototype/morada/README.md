# Morada: protótipo navegável de aluguel de imóveis

Abra `index.html` direto no navegador. Não precisa de instalação nem de servidor, e não usa biblioteca externa.
Os dados fictícios ficam em `data.js` e só vivem na memória da página.

A estrutura é de propósito diferente da do FarmaVirtual:
- as telas são seções fixas do `index.html` (`data-view`), mostradas por um roteador de hash;
- os modais são elementos `<dialog>` fixos;
- os ícones são SVG inline e as fotos são arquivos SVG em `assets/`;
- as interações saem de `data-action`, por delegação de eventos.

Para entrar, use "Entrar" no cabeçalho e escolha uma conta de demonstração. Ana e Diego são inquilinos; Bruno e
Carla são proprietários. É só uma simulação de sessão.

## Telas

| Tela | URL | Comportamento |
| --- | --- | --- |
| Buscar | `index.html#/buscar` | Filtros (cidade, tipo, quartos, aluguel máximo, mobiliado, pets), ordenação e lista com favoritar |
| Imovel | `index.html#/imovel/101` | Galeria com miniaturas, características, valores (aluguel, condomínio, IPTU, total), agendar visita, fazer proposta e favoritar |
| Favoritos | `index.html#/favoritos` | Imóveis salvos ou estado vazio |
| Propostas | `index.html#/propostas` | Tabela das propostas do inquilino, com status e cancelamento das pendentes |
| Anunciar | `index.html#/anunciar` | Formulário em seções, com validação; o anúncio novo entra pausado |
| Painel | `index.html#/painel` | Tabela dos anúncios do proprietário (pausar/ativar, editar, excluir) e propostas recebidas (aceitar/recusar) |

Modais: Entrar, Agendar visita, Fazer proposta, Editar anúncio, Confirmar.

## Regras do protótipo

- A busca mostra só anúncios ativos.
- Aceitar uma proposta recusa as outras pendentes do mesmo imóvel e pausa o anúncio.
- Excluir um anúncio remove também as propostas dele e o tira dos favoritos.
- Abrir o detalhe soma uma visualização.

## Modelo de dados sugerido

| Entidade | Atributos |
| --- | --- |
| Imovel | Id, Titulo, Tipo, Cidade, Bairro, Endereco, Quartos, Banheiros, Vagas, Area, Aluguel, Condominio, Iptu, Mobiliado, AceitaPets, Status, ProprietarioId, Visualizacoes, Descricao |
| ImovelFoto | Id, ImovelId, Url, Ordem |
| Proposta | Id, ImovelId, InquilinoId, Valor, Inicio, PrazoMeses, Status, EnviadaEm, Mensagem |
| Visita | Id, ImovelId, InquilinoId, Data, Horario, Mensagem |
| Favorito | UsuarioId, ImovelId |
| StatusProposta (estática) | Pendente, Aceita, Recusada, Cancelada |
| StatusAnuncio (estática) | Ativo, Pausado |

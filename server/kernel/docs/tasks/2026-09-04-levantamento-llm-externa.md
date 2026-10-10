# Levantamento: uma LLM externa a usar o SSAM Hybrid (2026-09-04, tarde)

Duas sessoes de uma LLM que nao e o Claude, sem contexto alem do repositorio, sobre a loja virtual de videogames
(`tests/jobs-cold/virtual-game-store-*`). A primeira converteu as actions para SQL com todos os inputs ligados; a segunda
implementou `Home`, `Catalog` e `GameDetail` no `Headless_UI` (20 min 54 s, 3 telas cruas). Este documento junta os dois
levantamentos numa lista unica, sem repetir familias, e diz de cada item se a solucao e deterministica (a via errada deixa
de existir ou falha na primeira execucao com a mensagem que ensina) ou se e so orientacao.

## Factos da segunda sessao (telas)

- Job final: 343 ops, `isValid=True`, 0 mensagens; 3 telas, 5 Data Actions, 6 Screen Actions; referencia a 6 entidades
  publicas do `Headless_CS`. Widgets: 4 List/ListItem, 18 Expression, 8 Button, 2 Link, 2 Dropdown, 1 Input, 1 Container.
  ZERO blocos do OutSystems UI (nenhum `source`), nenhuma imagem, tabela, card, carrossel, tabs, paginacao ou avaliacao
  com estrelas, apesar de a propria idealizacao os listar. Dai "cruas".
- 9 execucoes ate passar; 18 ficheiros lidos alem do guia, incluindo 4 ficheiros C# da bridge.
- Bridge (log 4516): `snapshot_module` com caminho relativo gravou em
  `...\Service Studio 11 - Anvil 4516\Service Studio\.local\producers\` (cwd do processo do Studio); o merge falhou duas
  vezes com `Matches cannot be set already when starting the match tree` depois do dialogo "Manage Dependencies";
  `open_module` ficou 180 s preso num dialogo ("Modified or missing references found"); dois restarts do Studio.
  CORRECAO (plano, item 13): os dialogos sao `DialogWindow` com webview, alvos do CDP como o de recuperacao; "invisivel ao
  CDP" nao foi verificado. E o 12 e o 13 sao o MESMO incidente: o produtor `Headless_CS` foi republicado as 11:58, o
  `open_module` do `Headless_UI` abriu o Manage Dependencies, que monta um MatchTree e deixa `Match` nos objetos; o
  merge seguinte recusa ("Matches cannot be set already"). Ver `docs/tasks/2026-09-04-plano-gaps.md`.
- O modulo de destino `Headless_UI` tem 218 warnings pre-existentes (galeria), que o TrueChange devolve misturados.

## Lista consolidada (1-9 da sessao SQL, 10-16 da sessao de telas)

| # | Familia | Onde apareceu | Solucao | Deterministica? |
|---|---|---|---|---|
| 1 | Worker residente com resultado diferente do frio | sessao SQL ("resultado antigo") | Verificado: 51 jobs identicos frio vs worker (objetos, mensagens, caminhos, aliases, resultados sem chaves). O que havia era fuga de memoria: `UndoManager` retinha o comando com o grafo inteiro por pedido (1 MB pequeno, 25 MB tickets), mais presenter/eventos, rebindActions, locks. Corrigido em `Publisher.Mutate` (ClearHistory), `HeadlessRuntime.Release*` e `ModelHost.Release`: 31 applies +0 MB (antes +31), 10x tickets 20 MB (antes 253). | Sim: teste de 10 rodadas identicas ao frio + heap plano |
| 2 | Bases mutaveis em `.local` | ambas (`.local/jobs/*.oml`, `.local/producers/Headless_CS.oml`) | Runner recusa `base`/`producer` fora de `tests/fixtures`, `job:` ou snapshot tirado pelo proprio `deliver`; GuideTest varre `tests/jobs*` | Sim |
| 3 | Mascarar warnings com `maxNewMessages` | sessao SQL | `expectedMessages: [{id, element, why}]`; `UnusedElement`/`UnusedUserAction` em elemento criado pelo job = falha | Sim |
| 4 | Inputs declarados e nao usados | sessao SQL (42) | Na spec `logic`, input nao referenciado = erro de compilacao com nome; em verbos, checagem pre-Verify | Sim |
| 5 | Jobs monoliticos e versoes no nome (v2..v7) | sessao SQL | Composto (`jobs`) + limite de ops por ficheiro + recusa de sufixo de versao; o texto so encolhe com a spec | Parcial |
| 6 | SQL: `MaxRecords`, `@X` sem parametro, `X = X` | sessao SQL | Tres checagens pre-Verify (parametros nos dois sentidos, propriedade inexistente por tipo, assign identico) | Sim |
| 7 | Entregas parciais "para sincronizar" | ambas (campos antes das actions; snapshot do produtor por fora) | `deliver` unico: snapshot, apply, merge, TrueChange numa transacao; recusa base diferente do snapshot | Sim |
| 8 | Ler ficheiros antes de agir | ambas (18 na sessao de telas, incluindo C# da bridge) | Superficie por comandos (`recipe`, `where-can`, `api`, `ui-block`, `functions`, `verify-message`, `explain`); sandbox so com o CLI como prova | Fecha com a superficie |
| 9 | Copias do mesmo job | sessao SQL | Persistencia pelo produto com regra de nome; versao no git | Sim |
| 10 | Telas cruas: nenhum bloco do OutSystems UI | sessao de telas | O guia lista os blocos (3.3) mas nao diz QUANDO: falta a linguagem de tela por arquetipo (lista de cards, detalhe com tabs, dashboard) que compila para blocos, com telas de ouro e prova visual. "Card de jogo = Card + Image + Expression + Button" tem de ser uma forma pronta, nao uma descoberta | Fecha com a spec de telas; ate la, guia "quando usar" por arquetipo |
| 11 | Bridge: `snapshot_module` com caminho relativo grava no cwd do Studio | sessao de telas | Bridge recusa caminho relativo ou resolve contra a raiz do repo | Sim (bug) |
| 12 | Merge falha depois de "Manage Dependencies" (`Matches cannot be set already`) | sessao de telas (2 falhas, 2 restarts) | O estado de Match fica nos objetos do modulo aberto apos a atualizacao de referencias; o MergeHandler tem de limpar/renovar antes do MatchTree, e a bridge tem de fazer o refresh de referencias ela propria quando o foreign traz referencias novas (o item ABERTO "add references headless") | Sim (bug) |
| 13 | Dialogos (web, `DialogWindow`) travam `open_module` 180 s em silencio | sessao de telas | `open_module` devolve em <= 5 s `blockedBy` com o dialogo (recuperacao, Manage Dependencies, missing references); fecho automatico so opt-in; prevenir o de referencias com `ServerSilentMode` no aggregator (plano 13a/13b) | Sim |
| 14 | Regra de ordem: destino de navegacao tem de existir antes do link | sessao de telas (2 execucoes) | O runner ordena por dependencia ou a mensagem diz "destino X ainda nao existe: crie a tela antes"; na spec de telas nao existe ordem | Sim |
| 15 | Contratos que o guia nao diz: lista de Data Action le `Out.Current.Attr` (sem entidade), `IDropdown` sem `Prompt`, static entities internas nao referenciaveis | sessao de telas (3 execucoes) | Texto no guia + `api --name` ja recusa propriedade inexistente; a spec de telas gera o caminho certo | Parcial (texto) / Sim (spec) |
| 16 | Warnings pre-existentes do modulo de destino misturados no TrueChange (218) | sessao de telas | `get_errors` devolve so o delta em relacao ao snapshot (novos vs pre-existentes) | Sim |

## Leitura

Sete das nove familias originais e cinco das sete novas fecham-se por mecanismo. As que nao fecham por mecanismo (8, 10,
parte de 15) sao a mesma coisa vista de tres angulos: a LLM nao sabe QUANDO usar o que existe, e vai ler ou improvisa. A
resposta e uma so, a linguagem de tela por arquetipo com formas prontas, mais a superficie por comandos que a serve.

Os bugs 11, 12 e 13 sao da bridge e custaram sozinhos uns 8 dos 20 minutos da sessao de telas (dois merges falhados, dois
restarts, um open_module de 3 minutos). Sao os mais baratos de fechar e os que mais fazem "as vezes funciona".

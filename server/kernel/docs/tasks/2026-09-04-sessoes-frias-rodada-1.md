# Sessoes frias, rodada 1 (2026-09-04, manha)

Metodo: cinco subagentes sem nenhum contexto (nem memoria, nem esta conversa), so com o repositorio e a instrucao "leia AGENTS.md
e faca a tarefa". Cada um entregou o job, o log de atrito (arquivos lidos alem do guia, execucoes, duvidas, sugestoes) e um resumo.
Objetivo: medir o atrito real que o produto impoe a uma LLM fria, e nao a minha opiniao sobre ele.

| Sessao | Tarefa | Execucoes ate passar | Arquivos lidos alem do guia | Job (agora permanente) |
|---|---|---|---|---|
| A | Entidade Invoice + static + SERVICE action que le, muda o status, grava e devolve Success | 1 | 5 | `service-action-update.json` |
| B | Tela Reactive com pesquisa `like`, Table, botao Refresh (Refresh Data) e navegacao para tela nova | 1 | 6 | `screen-search-refresh-reactive.json` |
| C | Tela Traditional + processo BPT com Human Activity e argumento + server action + timer | 1 | 5 | `process-expense-traditional.json` |
| D | Client action com no JavaScript, tela com input, botao, screen action e expressao | 1 | 4 | `client-js-format-reactive.json` |
| E | REST GET com query string e resposta com structure aninhada + server action que chama | 1 | 4 | `rest-query-nested.json` |

Resultado: 5/5 passaram na primeira execucao, 0 tentativas falhadas. O atrito que sobrou foi de leitura e deducao, nao de erro:
cada sessao precisou de 4 a 6 arquivos alem do guia, quase sempre para confirmar algo que o guia dizia por alto e o exemplo
mostrava por inteiro.

## Atritos encontrados e o que mudou

| Atrito (quem) | Correcao |
|---|---|
| "Public" citado sem a sintaxe (A, C) | Guia diz `set $x Public true` e para que elementos vale |
| Caminho literal dos placeholders da tela Traditional (C) | Secao 3.2 lista `$scr/#IWebBlockInstanceWidget/Title`, `/MainContent`, `/Actions`, `/Breadcrumbs` |
| Argumentos do Human Activity (C) | Linha do BPT explica `set Destination` e `$human/<Input>` |
| Como gravar um registro (A) | Paragrafo "Gravar e ler registros dentro de uma action" com CreateOrUpdate/Update/Delete/Get e `$no/Source` |
| Esquema da op `spec` (A) | Esquema completo no guia, com o que e opcional e os aliases gerados |
| Dois links no mesmo End; `name` vs `Label` em If/Assign (A) | Enunciado em "Fluxos" |
| Contradicao: guia manda `$btn/#ITextWidget Text`, jobs antigos punham Expression no botao (B, D) | Os 4 jobs antigos foram alinhados ao guia; `dump` passa a mostrar o Text |
| Regras de referencia so nos exemplos: `<No>.<Output>`, `$call/<Input>`, `$js/arg:` (D) | Enunciadas na secao 2 |
| Refresh de aggregate ausente do guia e marcado not-allowed no mapa (B) | Guia: `IRefreshDataNode` + `set DataSource`; o mapa so o testou em server action (o mapa e por tipo de pai, nao por runtime) |
| `IEntitySignature:User` para entidade de outro modulo (B) | Guia distingue `IEntitySignature:` (referenciada) de `IServerEntity:` (propria) |
| Filtro `like` sem exemplo (B) | Exemplo no guia e no job de B |
| `run_job.py` nao imprimia `find` e truncava `get`/`dump` (B, D) | Imprime `find`; limites 1.500 chars e 120 linhas |
| Query string e structure aninhada em REST sem exemplo (E) | Linha do REST explica; job de E cobre os dois |
| Catalogo do Model API nao tinha as interfaces do plugin REST (E) | Catalogo passa a incluir interfaces de plugins que estendem o Model API (470 interfaces, 27 REST) |
| Tipos de `value` (JSON boolean vs texto OutSystems) (C) | Enunciado na secao 2 |
| `base: job:<x>` so procura em tests/jobs; `ok=False` significa nada salvo (C) | Enunciado na secao 0 |

Todas as correcoes estao no AGENTS.md e nos jobs; a suite (53 testes) continua verde e os GuideTests garantem que todo job e citado.

## Proxima rodada

Tarefas diferentes, misturando familias (tela Mobile com local storage e padrao do OutSystems UI; email + timer; refatoracao
sobre um job existente; referencia entre modulos com o verbo `reference`; galeria de um bloco especifico com handler), para
confirmar que o atrito de leitura caiu e nao so o de erro. Meta: 0 falhas e no maximo 2 arquivos alem do guia por tarefa.

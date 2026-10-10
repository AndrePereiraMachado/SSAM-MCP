# Sessoes frias, rodada 2 (2026-09-04, fim da manha)

Mesmo metodo da rodada 1 (subagentes sem contexto, so o repositorio e "leia AGENTS.md"), com tarefas de outras familias e
mais compostas, depois das 16 correcoes da rodada 1.

| Sessao | Tarefa | Execucoes ate passar | Arquivos alem do guia | Job (agora permanente) |
|---|---|---|---|---|
| F | Mobile: client entity, client action que grava, tela com aggregate local, input + botao + recarga, Accordion do OutSystems UI | 2 | 10 | `local-storage-notes-mobile.json` |
| G | Traditional: entidade + static, email com input e Subject, server action com aggregate + ForEach + Send Email, timer | 1 | 6 | `email-digest-foreach-traditional.json` |
| H | Refatoracao sobre modulo existente: usages, rename de atributo e action, delete seguro em dois passos, atributo novo + Switch | 1 | 6 | `refactor-contact-reactive.json` |
| I | Dois modulos: `reference` ao produtor, tela com Table e link para detalhe com input, screen action que chama a action referenciada | 2 | 11 | `consume-reference-screens.json` |
| J | OutSystems UI: DatePicker com handler do evento, Tag, Tooltip em volta de Icon, Counter | 2 | 12 | `osui-datepicker-handler.json` |

Resultado: 5/5 passaram; 3 sessoes gastaram exatamente 1 execucao falhada cada, todas por lacunas de texto, nao de capacidade:

| Falha (sessao) | Causa | Correcao |
|---|---|---|
| `InvalidAttribute_BadAutoNumber` (F) | O guia dizia "Id AutoNumber obrigatorio" sem excecao para client entity | Linha "Client entity": Id SEM AutoNumber |
| `reference: producer job not found` (I) | `job:` no `reference` resolvia so na pasta do job; `base: job:` resolvia em tests/jobs | Ambos procuram na pasta do job e em tests/jobs; guia explica e diz onde fica o OML gerado |
| `has no child 'Datepicker_Input'` (J) | A pagina do bloco listava o nome do input na DEFINICAO do bloco; a instancia renumera (Input1) e o snippet sugeria `empty` | Paginas dizem "nomes renumerados, enderece por tipo" e, para blocos com Input de exemplo, mandam ligar `#IInput` em vez de esvaziar |

Atritos de leitura corrigidos no guia: chamar client action de uma screen action; placeholders do Layout Mobile; Expression direto
numa List; ForEach (RecordList, CycleTarget, volta e saida) e a regra geral do `link connector`; variavel local e captura de output
com Assign; saida de `usages`/`rename`/`delete`; `get` mostra expressoes como `@chave.#Prop`; inputs de handler nao usados sao
warning esperado; conversoes de data; como listar os blocos que o modulo referencia; texto dinamico em Link; structures vem com a
referencia. Ferramenta nova: `anvil api --name <Interface>` consulta o catalogo pelo nome curto (acaba o grep no JSON).

Leitura do resultado: o atrito de erro esta em 0-1 execucao por tarefa; o atrito de leitura continua alto (6 a 12 arquivos)
porque as tarefas compostas obrigam a costurar varios jobs. E exatamente o que a linguagem de tela e os idiomas devem eliminar:
a proxima rodada so faz sentido depois deles, com tarefas de tela inteira.

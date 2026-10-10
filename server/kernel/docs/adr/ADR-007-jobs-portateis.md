# ADR-007: Jobs portateis e snapshots explicitos

Data: 2026-09-04. Estado: implementado (plano de gaps, item 02).

## Decisao

O JSON guarda intencao reproduzivel: `base` e `producer` aceitam somente um fixture em
`tests/fixtures`, `job:<nome>` ou um nome ligado explicitamente a um snapshot no comando.
`--producer Nome=<oml>` e repetivel; nomes duplicados e argumentos malformados sao erros.
`--base <oml>` continua livre para aplicar sobre o snapshot do modulo aberto (P1).
Nao se tenta provar a origem do snapshot aqui; o registro na bridge pertence ao item 07.

A politica de caminhos vive em `JobSources`, sem carregar o Studio. `JobRunner` resolve as
bases, cadeias e referencias uma vez em C#, tanto pelo CLI frio como pelo worker. Python
repassa os argumentos; o soak conserva apenas seu cache explicito por rodada.
Cada dependencia usa a pasta do job que a declara, inclusive partes de compostos, seguida
por `tests/jobs`. A base das partes de um composto continua ignorada. Ciclos de base,
produtor ou composicao falham com a cadeia, antes de salvar o consumidor.

Todas as fontes sao materializadas antes de abrir o consumidor, preservando a transacao
de ops e evitando construir outro modulo durante um reference. Os ops do JSON nao mudam;
a copia executavel recebe os caminhos resolvidos. Jobs dependentes invalidos interrompem
a corrida. As saidas ficam em `<work>/producers/<id-da-corrida>/<nome>-<hash-do-caminho>.oml`:
sem cache entre corridas, sem colisoes entre jobs homonimos, testes, faixas e processos.

## Evidencia e consequencias

`consume-reference-screens` lia `.local/jobs/producer-public.oml`, produzido por outra
corrida. Onze bases e tres outros producers tambem apontavam para `.local`.
Agora sao `job:` ou nomes ligados. Os jobs frios conservaram todos os outros campos.
O guia tem um gate que varre `tests/jobs*`; testes cobrem politica, bindings, pasta do
produtor, partes compostas, ciclos, isolamento e round-trip do OML.

A regra de um job por intencao (sem sufixo de versao) continua a da etapa anterior;
consolidar os jobs frios versionados e trabalho separado. O gerador de galeria e a prova
de dialogos tambem geram nomes ligados, para que seus jobs continuem executaveis.

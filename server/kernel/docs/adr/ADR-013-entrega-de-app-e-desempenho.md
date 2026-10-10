# ADR-013: Entrega de app e desempenho

Data: 2026-09-05. Estado: implementado e medido no SS5.

## Problema observado

Na sessao Hire, dados ja eram aplicados em 10-15 segundos, mas a tarefa incluiu atualizacao da faixa,
investigacao/implementacao de indices e uma suite de 195,8 segundos com jobs de outra sessao ainda em desenvolvimento.
Nas actions houve cinco aplicacoes grandes que falharam durante a iteracao, duas suites amplas e diagnosticos repetidos.
A entrega final teve apply de 239,3 segundos em 277,9 segundos totais no SS4. Duracoes de comandos assincronos
se sobrepoem: elas nao podem ser somadas para atribuir todo o tempo da LLM. O numero do Mentor vem do dono, sem
benchmark controlado nosso. Relatorio: ../proofs/2026-09-05-hire-performance.json.

## Decisao e implementacao

A entrega de APP usa check-job seguido de deliver; nao altera o Anvil nem depende da suite inteira dos outros apps.
O proprio deliver mantem snapshot, apply transacional, Verify, merge unico, delta e checks. Manutencao de C#/bridge/
worker/compiladores continua exigindo regressao completa. Nao se remove validacao de negocio para cumprir tempo.
O guia separa os dois escopos e proibe expandir uma entrega em manutencao sem um pedido para isso.

JobPreflight checa sintaxe de spec/logic antes de carregar OML ou reconstruir bases. Retorna falhas independentes,
nomes repetidos, ciclos, aliases e parametros sem uso; contratos/referencias/expressoes do modelo continuam no Verify.
check-job funciona sem Studio instalado. apply e deliver invocam a checagem automaticamente. Deletes/renames crus
invalidam o rastreio antecipado de nomes entre ops: a sequencia continua sendo julgada pelo modelo, sem falso bloqueio
para delete seguido de recriacao. O comando nao tenta provar equivalencia semantica de duas actions.

ModelApiMetadata guarda exclusivamente Type/MethodInfo/PropertyInfo, sem instancias do modelo. A selecao de Create
mantem ordem de interfaces/overloads e depende do tipo concreto do pai. A contagem de assemblies separa entradas
quando novos plugins carregam; falhas de carregamento e buscas sem resultado nao sao memorizadas. Invocacao e
permissoes por runtime continuam no Studio. Um plano de Create contem apenas metadados, nao o pai capturado pelo callback.

Dentro de uma unica op logic, nomes de entidades/structures/assinaturas imutaveis e tipos podem ser reutilizados.
O indice preserva a ordem original; nomes de actions substituidas ficam fora da via rapida. Actions novas so usam o
handle direto se nao havia simbolo compativel anterior. Tudo que segura objetos e descartado em finally, antes da
proxima op, de rename/reference e de fechar o OML. Teste de rename entre duas ops logic e a suite de replace/reference
protegem essa fronteira. OwnedAction busca filhos diretos do modulo, mantendo a mesma condicao Parent == ESpace.

apply devolve timings por fase. Hints Current agora incluem ISQLNode.Type: logic sql:true nomeia o output List,
entao um campo e Rows.List.Current.List.Field. O erro ensina esse wrapper em vez de exigir novas sondas do agente.

## Contagem honesta e duplicacao

A copia entregue do Hire tem 172 nomes unicos. A spec tem 127 publicas e 45 helpers privados (34 Scope_*).
18 endpoints terminam sempre em excecao. Ha dois grupos de contratos/corpos identicos, ambos entre endpoints
indisponiveis (2 uploads e 8 rotinas em lote). API RequestUpload e ConfirmUpload tem intencoes diferentes, portanto
nao se apagam por uma comparacao textual. O inventario agora sai em check-job, apply e no wrapper de entrega;
contratos indisponiveis nao podem ser apresentados como integracoes implementadas. Contar 172 actions nao prova
172 operacoes de negocio completas, nem a seguranca dessas operacoes.

## Evidencia e limites

Mesmos JSON congelados, mesmos fixtures e runtime SS5: actions 134.964 ms -> 23.377 ms de parede (5,77x),
apply 121.898 -> 16.678 ms (7,31x). Dados 13.721 ms -> 6.055 ms com worker aquecido; a primeira execucao de uma
revisao otimizada mediu 10.528 ms. As duas execucoes de actions vieram depois de um job de dados. Objetos e Verify
preservados: 5.754/27.608 objetos, zero mensagens. Nao e uma distribuicao estatistica nem medicao de autoria por LLM.

235/235 testes isolados (2 m 3 s), 11/11 Python, check-job sem Studio em 245 ms. performance-lookup.json entregue
em Headless_UI no SS5 em 10.446 ms, 0 novas/14 preexistentes, sem publicacao. O SS4 ficou intacto. As metas de 2-3 min
para dados e 5-10 min para actions incluem autoria e precisam de uma nova sessao controlada para serem afirmadas.
O guia ajuda o agente a escolher o fluxo, mas nao e um sandbox que impeça uma LLM com shell aberto de executar outros comandos.

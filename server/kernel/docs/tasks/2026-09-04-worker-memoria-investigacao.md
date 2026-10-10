# Worker residente: investigacao da memoria (2026-09-04, tarde)

Pergunta do dono: o soak de 10 rodadas estimado em 15 min levou 30; o worker chegou a 17 GB numa corrida e 4,5 GB noutra.
E lixo por recolher (o coletor do .NET deixou acumular) ou fuga real (alguma coisa segura os modulos ja descartados)?

## 1. Medicao no worker vivo (pid 60308, 584 pedidos servidos)

| Pedido | Duracao | Heap antes | Heap depois | Working set |
|---|---|---|---|---|
| `ping` | 0,0 s | 3.497 MB | - | 4.566 MB |
| `gc` (coleta completa, 2x + finalizadores) | 9,7 s | 3.497 MB | 3.497 MB | 4.566 MB |
| `gc` outra vez | 9,3 s | 3.497 MB | 3.496 MB | 4.566 MB |

Duas coletas completas devolveram 0 MB: **nao e lixo, e fuga**. Alguma raiz viva segura os 3,5 GB.

Impacto do GC forcado que o worker fazia a cada pedido acima de 512 MB: com o heap em GB, cada coleta completa demora ~10 s
com o processo parado; o cliente faz `ping` com timeout de 1 s antes de cada comando, nao obtem resposta, conclui que o
worker morreu e cai para processo frio (3 a 4 s de arranque por comando). Foi isso que transformou 15 min em 30: nao era o
trabalho, era a coleta a bloquear o worker e o cliente a fugir dele.

## 2. Raiz da fuga: registo estatico do Studio

`ESpace.Load` (o construtor do modulo, ServiceStudio.Framework) chama `ESpaceInstances.AddEspace(this, ...)`, que guarda a
instancia num `ConcurrentDictionary<Guid, ESpace>` **estatico** (`ESpaceInstances.loadedESpaces`). O Studio usa esse
registo para "modulos abertos", eventos de load/unload, o cache do `ObjectCloner` (`Dictionary<ESpace, State>` estatico) e
o `ForceFullLoad`. So `ESpace.Close()` retira a instancia do registo, dispoe o OML e limpa o storage (`Storage.Cleanup`).

O nosso headless carregava (base, produtores do `reference`, `inspect`, `roundtrip`) e nunca fechava: num processo frio o
processo morre e a memoria volta; no worker residente cada `apply` deixava um modulo inteiro preso para sempre
(Headless_CS com o app de tickets = 5.294 objetos, dezenas de MB cada; 584 pedidos = 3,5 GB).

Fontes: `ServiceStudio.Framework` descompilado, classe `ESpaceInstances` (AddEspace/RemoveEspace/LoadedESpaces), `ESpace.Close()`
(chama `RemoveEspace`, `Oml.Dispose()`, `Storage.Cleanup(InstanceId)`), `ObjectCloner.internalState` (limpo pelo evento ESpaceUnload).

## 3. Correcao

- `ModelHost.Release(espace)` = `ESpace.Close()` tolerante; chamado em `finally` no `JobRunner.Run` (modulo + todos os
  produtores), `Inspect`, `References`, `RoundTrip` e `RelayoutFromOml`.
- `ModelHost.LoadedModules()` le `ESpaceInstances.LoadedESpaces` por reflexao; o `ping` do worker passa a devolver
  `loadedModules` e o comando novo `leak` devolve modulos retidos por nome, heap antes/depois de GC completo e veredicto.
- O worker deixa de forcar GC a cada pedido: so acima de 2 GB, e nao bloqueante (`GC.Collect(2, Optimized, blocking: false)`).
- `anvil_cli.ping` com timeout de 3 s em vez de 1 s.

## 4. Medicao depois da correcao (worker novo, pid 59576)

| Momento | Modulos retidos | Heap antes -> depois de GC | Working set | Pedidos |
|---|---|---|---|---|
| Arranque | 0 | 0 -> 0 MB | 61 MB | 2 |
| 20x `service-action.json` (9,2 s no total, 270 ms o ultimo) | 0 | 57 -> 30 MB | 229 MB | 45 |
| 3x `tickets-all.json` (10,1 a 10,6 s cada; frio: 19 a 20 s) | 0 | 127 -> 105 MB | 333 MB | 56 |

Zero modulos retidos em todos os pontos; o heap apos GC cresce devagar (30 -> 105 MB) e a tendencia com 460 jobs esta no
soak abaixo (se crescer linearmente ha uma segunda raiz menor; se estabilizar sao caches do runtime).

## 5. Soak de 10 rodadas com a correcao (13:35-13:54)

49 jobs por rodada; rodada 0 frio = 386 s; rodadas 1-10 no worker = 56 a 85 s (15 a 22% do frio); 0 erros novos.

| Rodada | Tempo | Working set | Heap apos GC completo | Pedidos |
|---|---|---|---|---|
| 1 | 58 s | 1.785 MB | 1.017 MB | 255 |
| 3 | 60 s | 4.149 MB | 2.835 MB | 653 |
| 5 | 62 s | 6.766 MB | 4.653 MB | 1.051 |
| 8 | 72 s | 9.473 MB | 7.380 MB | 1.648 |
| 10 | 85 s | 10.923 MB | 9.205 MB | 2.050 |

Duas conclusoes:

1. **Ha uma segunda raiz.** Com `ESpaceInstances` vazio (0 modulos retidos, confirmado pelo `leak`), o heap apos GC completo
   ainda cresce ~900 MB por rodada, linear, ~4 MB por pedido. Nao sao os modulos: e outra coisa que cresce por pedido (uma
   colecao estatica keyed por instancia, um cache de verify, um log). A proxima medida e a sonda `leak-statics` (percorre os
   campos estaticos dos assemblies do Studio e devolve as colecoes grandes), que fica pronta assim que se puder compilar sem
   interferir com a sessao que esta a usar o worker. O tempo por rodada tambem sobe (58 -> 85 s) com o heap: e o custo do GC
   a percorrer memoria viva.
2. **"16 assinaturas diferentes do frio" era falso alarme.** Comparando chave a chave o `aggregate-full` frio e no worker, a
   unica diferenca e `validation.Sample`, que cita o ObjectKey do elemento (`@ 9UKfT+...` vs `@ P3B6m3...`); as chaves sao
   geradas de novo em cada execucao, tambem entre dois processos frios. O soak passa a excluir o `Sample` da assinatura (o
   resto, incluindo os detalhes do Verify com caminho por NOME, e identico). O worker nao mudou nenhum resultado.

Estado apos a seccao 5: deterministico e 5 a 7x mais rapido que o frio, mas com a segunda raiz por fechar (seccao 7).

## 6. O que fica

- Regra: todo `ESpace.Load` tem um `Release` em `finally`. Codigo novo que carregue modulos (galeria, scan de corpus, provas)
  em processo residente tem de seguir a regra; em processo frio nao faz diferenca.
- `leak` e `ping.loadedModules` sao a sonda: `python -c "import anvil_cli; print(anvil_cli.run([\"leak\"])[\"data\"])"`.
- GC forcado bloqueante nunca no caminho de um pedido.

## 7. Segunda raiz: encontrada e fechada (16:00-17:00)

Metodo: comando `statics` no worker (percorre os campos ESTATICOS de todos os assemblies ServiceStudio.*/OutSystems.*/Anvil.* e
devolve o tamanho de cada colecao e a lista de invocacao de cada evento estatico), chamado no FIM de um processo que serviu 1
apply e no fim de outro que serviu 31 (o scan dispara construtores estaticos e nao pode correr antes do primeiro apply: envenena
o runtime, "Provider not initialized"). Diferenca entre os dois = o que cresce por pedido. Job: `aggregate-full` (280 objetos).

| Campo estatico que cresceu (+30 em 30 pedidos) | O que segura | Correcao |
|---|---|---|
| `ServiceStudio.Undo.UndoManager.commandsToUndo`, `commandsPendingClose`, `OperationsCountAfterSave` | o comando "apply job" com o grafo INTEIRO criado pela mutacao, indexado pelo presenter que executou o comando. E a massa: 1 MB por modulo pequeno, 25 MB por app de tickets | `Publisher.Mutate` cria um `MockAggregatorPresenter` proprio para `Command.Execute`; o Dispose nao limpa o historico. Agora chama `UndoManager.ClearHistory(aggregator)` em `finally` |
| `ESpaceInstances.eSpaceLoad` / `eSpaceUnload` (listas de invocacao, +2 cada) | o `MockAggregatorPresenter` do runtime (um por modulo, `ConditionalWeakTable`) cria `PTAEntryPointsList` e `TestTenantsManager`, que subscrevem os eventos estaticos e so os largam no Dispose | `HeadlessRuntime.ReleaseAggregator`: dispoe os dois servicos e o presenter e tira-o da tabela |
| `ServiceStudio.Expressions.ParsedExpression.rebindActions` (+1) | acoes de rebind por `ESpace.InstanceId` | `ReleaseStudioStatics`: `TryRemove(InstanceId)` por reflexao |
| `UndoManager.alternativeCommandId` (+1) | Guid por InstanceId | `ReleaseStudioStatics`: `Remove(InstanceId)` |
| `OutSystems.Model.Concurrency.TransferableReaderWriterLock.Instances` (+1) | os `IModelLock` do ESpace, que so saem no Dispose e `ESpace.Close` nao dispoe | `ReleaseLocks`: dispoe os campos `IModelLock` do ESpace depois do Close |
| `WeakDelegate._allWeakDelegates` (+2), `ESpaceInstances.closedESpacesInfo` (+0,2) | referencias fracas e registos de fecho | ficam: nao seguram modulos (bytes por pedido) |

Ordem em `ModelHost.Release`: `ReleaseStudioStatics` -> `ReleaseAggregator` -> `ESpace.Close` -> `ReleaseLocks`; o relatorio do
que foi libertado vai no resultado do `apply` (`released`). Medicao com a correcao completa (worker `cli-diag`, porta 4519):

| Processo | Heap apos GC completo | Antes da correcao |
|---|---|---|
| 1 apply de `aggregate-full` | 7 MB | 8 MB |
| 31 applies de `aggregate-full` | 7 MB (+0) | 39 MB (+31) |
| 10 applies de `tickets-all` (5.294 objetos cada) | 20 MB | 253 MB |

Suite completa com a correcao: 80/80 verdes (2 m 35 s).

Sobre a "inconsistencia" do worker relatada por uma LLM externa ("resultado antigo"): os 51 jobs da suite aplicados no frio e
no worker com 2.050 pedidos sao identicos em objetos, mensagens, caminhos, aliases e resultados por operacao (as ObjectKeys,
geradas de novo em cada execucao, mascaradas). O "resultado antigo" encaixa na base mutavel em `.local` que o job usava.

## 8. Soak de 10 rodadas com a correcao completa (16:57-17:15, worker pid 44044)

51 jobs por rodada; a assinatura exclui `TopObjectTypes` (top-15 com desempate por ordem de travessia, que varia tambem entre
dois processos frios) e `Validation.Sample` (ObjectKeys). Rodada 0 frio = 407 s; rodadas 1-10 = 61 a 75 s (15 a 18% do frio).

| Rodada | Tempo | Assinaturas diferentes do frio | Erros novos | Working set | Heap apos GC completo | Pedidos |
|---|---|---|---|---|---|---|
| 1 | 75 s | 0 | 0 | 371 MB | 19 MB | 208 |
| 5 | 62 s | 0 | 0 | 414 MB | 47 MB | 1.036 |
| 10 | 62 s | 0 | 0 | 525 MB | 82 MB | 2.072 |

Veredicto do script: DETERMINISTICO, worker aprovado. O residuo de ~30 KB por pedido e o registo de `WeakDelegate` (referencias
fracas) e `closedESpacesInfo`; em 2.072 pedidos sao 82 MB, contra 9.205 MB antes da correcao. O tempo por rodada deixou de
subir (antes 58 -> 85 s com o heap a crescer). Estado: o worker pode ficar residente por horas e e o caminho por omissao.

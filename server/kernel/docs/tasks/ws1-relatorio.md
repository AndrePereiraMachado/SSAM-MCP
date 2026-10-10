WS1 Adapters.ODC headless — estado: concluído (6/6 testes ODC; suíte SS11 com as mesmas 151 falhas da base, 0 novas)
Branch/pasta: ws/1-odc-headless em C:\Users\andre\Anvil-ws1 (de anvil 03dbf4d); commits 3f42fef, a178fed, edc44e0, 0499834
Tarefas: [x] T1 csproj ODC [x] T2 runtime (load/save/verify/transação) [-] T3 MergeTree (não existe no contrato WS0: merge ODC é a bridge, WS2) [x] T4 catálogo Verify [x] T5 jobs ODC [x] T6 testes ODC

Provas:
- `dotnet build src/Anvil.Core.Odc -c Release --nologo` -> "0 Erro(s)" (5 avisos, os mesmos do kernel no SS11).
- `dotnet build src/Anvil.Cli -c Release --nologo` -> "0 Erro(s)" (SS11 continua a compilar com as edições do kernel).
- `dotnet test tests/Anvil.Tests.Odc -c Release` -> "Aprovado! – Com falha: 0, Aprovado: 6, Ignorado: 0, Total: 6, Duração: 31 s":
  TheRuntimeIsTheOdcAdapter (StudioAdapter.Runtime é OdcRuntime, Platform "odc", IdeVersion da instalação);
  TheFixtureLoadsSavesAndReloads (wrightflood-personal-r8.oml: 59 281 objetos, save 1 MB+, recarga com a mesma contagem);
  TheVerifyCatalogComesFromTheInstalledOdcStudio (definições lidas de OutSystems.Model.dll);
  JobAppliesAndVerifies x3: data-entity (spec: static WfProofStatus com 2 records, entidade WfProofContact com FK e
  defaults; `isValid=True`, contrato de dados aceito, 0 mensagens novas), logic-action (logic: get com where, assign, if;
  `isValid=True`, só o UnusedUserAction declarado com why), screen-basic (tela em MainFlow sobre LayoutTopMenu do
  próprio módulo: expressão no Title, container com expressão, input ligado a variável local, botão ligado a screen
  action com assign; `isValid=True`, 0 mensagens novas). Resultados em .local/lane-odc/test-work/<job>.result.json.
- `dotnet test tests/Anvil.Tests -c Release` (SS11, sobre 0499834 + este relatório): "Com falha: 151, Aprovado: 1005,
  Ignorado: 0, Total: 1156, Duração: 24 m 57 s". Comparação nome a nome com a base do WS0 (mesma regra 1.8): 151 nomes
  na base, 151 no ws1, 0 novos, 0 desaparecidos (os cinco pares que o `Compare-Object` listou diferem só na
  codificação do "···" que o xunit põe nos nomes longos, nos dois logs). Nenhuma falha cita Anvil.Core.Odc, OdcRuntime,
  VerifyResources, FunctionCatalog.Visibility ou os pontos do kernel editados.

Arquivos criados: src/Anvil.Core.Odc/Anvil.Core.Odc.csproj; src/Anvil.Core.Odc/Adapters.ODC/{OdcRuntime,StudioAssembliesOdc,
  OdcFeatures,FunctionCatalogOdc,GlobalUsings}.cs + README.md; src/Anvil.Core/Kernel/{VerifyResources,BridgeCallException,
  NativePerformanceCapture}.cs; src/Anvil.Core/Adapters.SS11/FunctionCatalogSs11.cs; tests/Anvil.Tests.Odc/{Anvil.Tests.Odc.csproj,
  OdcJobTests.cs,xunit.runner.json}; tests/jobs-odc/{data-entity,logic-action,screen-basic}.json;
  tests/fixtures/odc/wrightflood-personal-r8.oml (+ .json); docs/tasks/2026-09-17-ws1-diferencas.md.
Arquivos movidos: Adapters.SS11/EntityIndexes.cs -> Kernel/EntityIndexes.cs (git mv); NativePerformanceCapture saiu de
  Publisher.cs; BridgeCallException saiu de BridgeClient.cs.
Arquivos alterados no kernel (extensão do WS0, feita pelo integrador, sem `#if`): Verbs.cs (casts, IExpression sem
  qualificar, ranking/retry do Create, CreateWidget(Type), Convert para ExpressionDefinition, Remembered, seletor #ITipo
  dentro de IContent), ScreenModel.cs, ScreenRequirements.cs, LogicRequirements.cs, LogicExpander.cs, DataAssertions.cs,
  DataDelta.cs, DataRequirements.cs, ManagedCSharpTypes.cs, ManagedUiCode.cs, UiNativeImports.cs, HtmlDelta.cs,
  ModelHost.cs, ExpressionCheck.cs, FunctionCatalog.cs (parcial); Delivery/Delivery.cs (comentário);
  Adapters.SS11/VerifyCatalog.cs (delega ao leitor comum), Publisher.cs, BridgeClient.cs.
Fora do brief: (1) projeto ODC em src/Anvil.Core.Odc/ e não em src/Anvil.Core/ (dois csproj na mesma pasta
  partilhariam obj/ e os globs); (2) testes ODC num projeto separado tests/Anvil.Tests.Odc (os mesmos nomes de tipo
  compilados contra DLLs diferentes não cabem num assembly de testes); (3) o brief pedia "não contornar editando o
  kernel": o dono decidiu (17/09 01:05) que os 105 erros de compilação e as diferenças de execução fossem resolvidos
  no kernel pelo integrador, guardados pela suíte SS11; a lista está em docs/tasks/2026-09-17-ws1-diferencas.md.
Tempo: ~3 h de sessão do integrador, mais a suíte SS11.

Dúvidas/tarefas para o integrador:
1. Não há CLI do Anvil compilado contra o ODC (`anvil.dll` é SS11): para a sessão fria do INT correr um job Anvil na
   faixa ODC sem xunit, falta um `Anvil.Cli.Odc` (as fontes do CLI sobre `Anvil.Core.Odc`) ou `run_job.py --lane odc`
   passar pelos testes ODC. Decisão do INT.
2. `ImportReference` devolve NotSupported no ODC (nomeia `refresh-references` da bridge): WS2 cobre a parte viva.
3. `FunctionCatalog` do ODC: três visibilidades são predicados sobre o módulo; sem módulo, "precisa do módulo" conta
   como visível. Se um dia o catálogo ODC for exposto por verbo, decidir se se avalia por módulo.
4. WS4 T7 (jobs html-visual sobre a fixture ODC) fica para depois do merge de ws/1 em anvil (os jobs vivem lá).

WS0 Contrato do adaptador no Anvil — estado: concluído (suíte comparada com o `anvil` intocado; ver Provas)
Branch/pasta: ws/0-adapter-contract em C:\Users\andre\Anvil-ws0 (de anvil 53ef2cb); commit 1b2d318 + commit final
Tarefas: [x] T1 inventário [x] T2 interfaces [x] T3 StudioAdapter [x] T4 SS11 implementa [x] T5 chamadas do kernel [x] T6 suíte

Provas:
- `dotnet build src/Anvil.Cli -c Release --nologo` -> "0 Erro(s)" (10 avisos pré-existentes).
- `dotnet test tests/Anvil.Tests -c Release` no ws0 (final): "Total de testes: 1156, Com falha: 151, Tempo total:
  25,4 min"; 0 falhas não explicadas pela base. Detalhe: 151 falhas, TODAS pré-existentes no `anvil` intocado, provado por
  comparação de nomes: 90 em JobTests = os mesmos 90 que falham no `anvil` (JobTests inteira rodada lá: 78 aprovados,
  90 falhas, 0 só de um lado); 52 em ScreenCoverageTests por `tests\fixtures\outsystems-ui-web.oml` ausente do
  repositório (main tem só 4 fixtures); 9 em FunctionCatalog/Guide/NativeCSharp/Temporal/Surface = as mesmas 9 que
  falham no `anvil` (rodadas lá: 9 falhas, 0 só de um lado). Nenhuma falha cita IStudioRuntime, StudioAdapter,
  Ss11Runtime, ModelHost ou NativeReferenceSnapshot. Regra aplicada: "verde" = mesmas falhas do `anvil`, nenhuma nova.
- Inventário: docs/tasks/2026-09-17-ws0-inventario.md (o contrato é exatamente o que o kernel chama).

Arquivos criados: src/Anvil.Core/Kernel/Adapter/{IStudioRuntime,StudioAdapter,VerifyDefinition,PublishOutcome}.cs,
  src/Anvil.Core/Adapters.SS11/{Ss11Runtime,NativeReferenceCapture}.cs, docs/tasks/2026-09-17-ws0-inventario.md.
Arquivos movidos (git mv): Adapters.SS11/ModelHost.cs -> Kernel/ModelHost.cs; Adapters.SS11/NativeReferenceSnapshot.cs
  -> Kernel/NativeReferenceSnapshot.cs (sem `: IModuleSignature`, sem `Capture(ReferenceInfo)`).
Arquivos alterados (uma linha por chamada): Kernel/FlowLayout.cs, MergeProbe.cs, ProofGenerator.cs (4), UiGallery.cs,
  ModelApiMetadata.cs, Verbs.cs (2); Delivery/CSharpRuntimeDelivery.cs (Capture); Adapters.SS11/ReferenceRefresher.cs
  (SnapshotSignature), Publisher.cs e VerifyCatalog.cs (records removidos).
Fora do brief: nada. Nenhum csproj alterado (compile items por padrão).
Tempo: ~2 h de sessão, mais ~1 h de suíte.

Dúvidas/tarefas para o integrador:
1. O `anvil` tem 150 testes vermelhos por ambiente e conteúdo (fixture ausente, jobs com base em `.local`, jobs
   `incidents-*` em curso, catálogo de funções para o Studio 11.55.87, dois jobs citados no guia que não existem).
   Limpar fora dos briefs.
2. `StudioAdapter` descobre a implementação por reflexão (única no assembly). O WS1 cria `OdcRuntime` num csproj
   separado que NÃO inclui `Adapters.SS11`; se um dia os dois entrarem no mesmo assembly, `StudioAdapter.Use(...)`
   passa a ser obrigatório.
3. `ImportReference` e `NativeReferenceSnapshot` cobrem só extensões (O11). No ODC o WS1 decide se implementa ou
   devolve NotSupported nomeando a alternativa.

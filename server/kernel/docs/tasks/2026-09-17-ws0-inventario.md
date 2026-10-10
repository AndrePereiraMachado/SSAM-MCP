# WS0 T1: inventario do que o kernel chama no adaptador SS11

Medido em 2026-09-16 sobre `src/Anvil.Core` (branch `ws/0-adapter-contract`, base `anvil` 53ef2cb), por grep de
`Tipo.Membro` e de usos do tipo como valor em `Kernel`, `Delivery` e `Hosting`. A interface do adaptador e
exatamente esta lista; nada a mais.

## Membros usados

| Tipo (Adapters.SS11) | Membro | Onde (arquivo:vezes) | Destino |
|---|---|---|---|
| `ModelHost` | construtor (chama `HeadlessRuntime.Ensure`) | CorpusScan, JobRunner:4, MergeProbe, ProofGenerator, UiCatalog, UiGallery, CSharpRuntimeDelivery:5 (valor) | `ModelHost` vai para `Kernel`; o construtor chama `StudioAdapter.Runtime.Ensure` |
| `ModelHost` | `Load(byte[])`, `Load(string)`, `Save` | internos de ModelHost e JobRunner/UiCatalog via instancia | `IStudioRuntime.Load/Save` |
| `ModelHost` | `Release` (estatico) | JobRunner:3, MergeProbe:3, ProofGenerator:1 | `IStudioRuntime.Release` |
| `ModelHost` | `Describe`, `Messages`, `ValidationDetails`, `PathOf`, `Prop`, `Kind` (estaticos, so Model API) | CorpusScan, JobRunner, MergeProbe, UiGallery, Verbs, DataAssertions, ExpressionCheck, FrameworkRuntimeModel, HtmlDelta, ScreenContracts, UiNativeImports | ficam em `ModelHost` (kernel), sem adaptador |
| `Publisher` | `Mutate(ESpace, string, Action<ESpace>)` | FlowLayout:1, MergeProbe:1, ProofGenerator:3, UiGallery:1, Verbs:2 | `IStudioRuntime.Mutate` |
| `StudioAssemblies` | `Bind`, `Directory`, `IdeVersion` | Catalog:1, ModelApiMetadata:1, ProofGenerator:1 | `IStudioRuntime.Bind/StudioDirectory/IdeVersion` |
| `VerifyDefinition` (record) | tipo | CommandSurface:1 | record vai para `Kernel/Adapter`; `IStudioRuntime.VerifyDefinitions` |
| `HeadlessRuntime` | `Ensure`, `ReleaseAggregator`, `ReleaseStudioStatics`, `ReleaseLocks` | so dentro de `ModelHost` | escondidos atras de `Ensure`/`Release` |
| `NativeReferenceSnapshot` | `Read`, `Select`, `Bind`, `RequireEnvironment`, `Write`, `Name`, `ModuleKey`, `Environment`, `SignatureHash`, `Elements` | JobRunner, Verbs, DeliveryReceipt, FrozenFrameworkDependencies, CSharpRuntimeDelivery | record de dados vai para `Kernel` sem `IModuleSignature`; o adaptador SS11 o embrulha |
| `NativeReferenceSnapshot` | `Capture(ReferenceInfo, ...)` | CSharpRuntimeDelivery:1 | fica no SS11 (`ReferenceInfo` e DTO do Service Center) |
| `ReferenceRefresher` | `ImportSnapshot(ESpace, snapshot, elements)` -> `Reference` | Verbs:1 | `IStudioRuntime.ImportReference` |
| `HeadlessSession` | `Connect`, `MarkReadOnly` | CSharpRuntimeDelivery:1 | fica no SS11: entrega de runtime C# e capacidade O11 |
| `PublishOutcome` (record) | tipo | PublicationBatch:4 | record vai para `Kernel/Adapter` (dados) |
| `EntityIndexes` | `Create`, `IncludeNative`, `Read`, `TypeName` | DataAssertions, DataDelta, DataRequirements, Verbs | so Model API V1: vai para `Kernel` como esta |

## Arquivos do kernel que tocam o adaptador (21)

Catalog, CorpusScan, CSharpRuntimeDelivery, DataAssertions, DataDelta, DataRequirements, DeliveryReceipt,
ExpressionCheck, FlowLayout, FrameworkRuntimeModel, FrozenFrameworkDependencies, HtmlDelta, JobRunner, MergeProbe,
ModelApiMetadata, ProofGenerator, ScreenContracts, UiCatalog, UiGallery, UiNativeImports, Verbs.

## Contrato resultante (`Kernel/Adapter/IStudioRuntime.cs`)

```
string Platform { get; }                       // "ss11" | "odc"
string StudioDirectory { get; }
string IdeVersion { get; }
void Bind(string? studioDirectory = null);
void Ensure(string workDirectory);
ESpace Load(byte[] oml);
byte[] Save(ESpace espace);
Dictionary<string,int> Release(ESpace? espace);
void Mutate(ESpace espace, string description, Action<ESpace> mutation);
Reference ImportReference(ESpace espace, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements);
IReadOnlyList<VerifyDefinition> VerifyDefinitions { get; }
```

`StudioAdapter.Runtime` e o ponto unico de acesso; por padrao o SS11 (`Ss11Runtime`, no `Adapters.SS11`), que
delega para `HeadlessRuntime`, `StudioAssemblies`, `Publisher.Mutate`, `ReferenceRefresher.ImportSnapshot` e
`VerifyCatalog` sem alterar nenhum corpo de metodo. O ODC implementa a mesma interface no WS1.

Fora do contrato, de proposito: `HeadlessSession`, `Publisher.Publish/StartPublish/CheckPublish`,
`ReferenceRefresher.Refresh/Staleness`, `TemplateModules`, `AppFactory`. Sao servidor e ciclo de vida, usados pelo
`Anvil.Cli`, nao pelo kernel; a faixa ODC os cobre com o bridge (WS2/WS3).

# Adicionar referencias novas (Manage Dependencies) num modulo O11 carregado headless

Investigacao no decompilado do Service Studio 11.55.69 (somente leitura). Data: 2026-09-04.

## Convencoes de citacao

| Alias | Arquivo |
|---|---|
| `PRS` | `C:\Users\andre\GitSSAM\.ssam\local\native-dll-decompile\source\ServiceStudio.Presenter\ServiceStudio.Presenter.decompiled.cs` |
| `FW` | `...\source\ServiceStudio.Framework\ServiceStudio.Framework.decompiled.cs` |
| `V1` | `...\source\OutSystems.Model.V1\OutSystems.Model.V1.decompiled.cs` |
| `MI` | `...\source\OutSystems.Model.Implementation\OutSystems.Model.Implementation.decompiled.cs` |
| `SC` | `...\source\ServiceStudio.ServerCommunications\ServiceStudio.ServerCommunications.decompiled.cs` |
| `API` | `...\source\ServiceStudio.ServerCommunications.API\ServiceStudio.ServerCommunications.API.decompiled.cs` |
| `VIEW` | `...\source\ServiceStudio.View\ServiceStudio.View.decompiled.cs` |
| `ANV/*` | `C:\Users\andre\Anvil\src\Anvil.Core\Adapters.SS11\*.cs` |

Nomes `prs#xxxx` sao membros ofuscados do Presenter; quando citados, o acesso e por reflexao (por tipo/assinatura, nunca pelo nome).

## 0. Resumo executivo

Existem tres caminhos para materializar referencias novas sem GUI; do mais robusto ao menos:

| # | Caminho | Fonte da assinatura do produtor | O que reusa | Estado |
|---|---|---|---|---|
| A | `ReferencesManager` headless (o motor do Manage Dependencies, sem view): `InitializeAddReferences` -> `SetIsChecked(match,true)` -> `CommitRefreshReferences` | `SignatureBinary` do Service Center (`HeadlessSession.GetReferenceSignature`, ja existente) | 100% do codigo do Studio, incluindo dependencias transitivas, hidden elements, tenant, nomes | Recomendado. E exatamente o que o Studio faz por tras do dialogo (PRS:101098-101165) |
| B | Model API publica com o produtor carregado como `ESpace`: `IESpace.RefreshDependencies(params IShareable[])` (adiciona E refresca) ou `IESpace.AddDependency<ConcreteT,SignatureT>(IShareable)` (adiciona 1 elemento) | OML do produtor carregado headless (nao precisa de servidor) | `ObjectCloner` + `MatchTree` do Framework | Funciona, mas o `Reference` criado fica com `ReferenceHash` vazio (nao ha mapeamento ESpace->ReferenceHash, FW:86212-86219) e o `IsValid` do produtor e obrigatorio (FW:823005-823011) |
| C | Construir `Reference`/`ReferenceEntity`/... a mao pelos construtores publicos | nenhuma | nada | Nao recomendado: sem `FullSignatureHash`/`CompatibilitySignatureHash`, sem tipos/anonymous structures ligados, sem `AcknowledgeNewTopLevelReferenceElements` |

`ICommandServices.RefreshReferences` (o unico verbo publico que o Anvil ja usa) **nao adiciona** nada: so refresca referencias que ja existem no consumidor (secao 3).

---

## 1. `ReferencesESpace.LoadSignatures`: o que faz e de onde vem a assinatura

### 1.1 `ReferencesESpace` e um `ESpace` descartavel ("Dummy_ARR")

- `ReferencesManager.ReferencesESpace` e uma propriedade publica do tipo `ESpace` (PRS:226180-226192).
- E criada em `prs#gikpneds` (inicializacao do manager): `ReferencesESpace = ESpace.CreateForRefreshReferences(localESpace.ESpaceType, localESpace.IsInIsolated)` (PRS:226308).
- `ESpace.CreateForRefreshReferences` = `CreateUnregistered("Dummy_ARR", eSpaceType)` + `IsInIsolated` (FW:102383-102388); `CreateUnregistered` chama o ctor privado com `isUnregisteredESpace: true` (FW:102390-102395), ou seja, um ESpace vazio fora do registo de espaces carregados.

### 1.2 `LoadSignatures` e um metodo do proprio `ESpace`, e nao fala com o servidor

```csharp
// FW:105800-105805
public IEnumerable<Reference> LoadSignatures(IBaseTopLevelPresenter baseTopLevelPresenter, IEnumerable<ObjectKey> signatures, CancellationToken token = default)
{
    ESpaceInstances.IsUnregisteredESpace(this).MustBeTrue();
    signatureDeserializer.MustBeSet();
    return signatureDeserializer.Load(signatures, token);
}
```

- Exige que o ESpace seja *unregistered* (FW:105802; `ESpaceInstances.IsUnregisteredESpace` FW:662589-662592) e que `InitializeSignatureDeserializer` tenha sido chamado antes (FW:105803).
- `InitializeSignatureDeserializer(Func<IEnumerable<ObjectKey>, IEnumerable<ReferenceInfo>> loadSignatureInfo, Action<ObjectKey,int> telemetryReporter = null, Action<int,int> progressReporter = null, ILogger logger = null)` (FW:105807-105810) cria um `SignatureDeserializer` (FW:88777-88810). **A assinatura vem exclusivamente do delegate `loadSignatureInfo`**: ele recebe chaves de produtores e devolve `ServiceStudio.ServerCommunications.API.ReferenceInfo` (API:3254-3337), cujo campo `SignatureBinary` (API:3266) e o que e desserializado.
- O parametro `baseTopLevelPresenter` nao e usado (FW:105800-105805).

### 1.3 O que `SignatureDeserializer.Load` faz com o `SignatureBinary`

- `Load` (FW:88812-88966): chama `loadSignatureInfo(keys)` (FW:88819), depois em loop `LoadSignatures(...)` (FW:88835) e, enquanto houver objetos "referidos mas nao carregados" (`referedButNotLoadedObjects`, FW:88854-88861) ou o sinal `loadSystem` (roles/processes exigem o "(System)", FW:88848-88851 e FW:89091-89094), volta a pedir mais chaves ao delegate (FW:88869). No fim: `LoadReferedButNotLoadedObjects` (FW:88883), `OnAfterSignatureDeserialization` por objeto (FW:88895), `RebuildReferers` (FW:88901), marca `Hidden`/`CompatibilitySignatureHash`/`FullSignatureHash` de cada `ITopLevelReferenceElement` (FW:88922-88945), `HandleUnavailableObjects` (FW:88948) e `SynchronizePlaceholderArguments` de web block instances (FW:88959-88962).
- `LoadSignatures` interno (FW:88981-89046): para cada `ReferenceInfo` cria `new Reference(ownerESpace, referenceInfo.Name) { ReferenceKey, ReferenceKind, ReferenceHash = SignatureHash, Description, JQueryVersion, Image = Icon, EspaceType, ReferenceType = RuntimeKind, IsMobilePlugin }` (FW:89004-89015) e chama `DeserializeSignature` (FW:89033). Se `SignatureBinary` estiver vazio, marca `HasDeserializationErrors` e loga (FW:89021-89031).
- `DeserializeSignature` (FW:89048-89114): `Oml.GetSignatureReader(referenceInfo.SignatureBinary)` (FW:89050) -> le `CreatedByTool` (FW:89052-89056) -> itera `ElementSignatures/ElementSignature` (FW:89057-89062), cada um com `OriginalKey`, `ParentOriginalKey`, `Hidden`, `CompatibilitySignatureHash`, `FullSignatureHash` (FW:89064-89075) e o `FullElementSignature` (XML do elemento) (FW:89076); descobre o `AbstractObjectKind` pelo tag name (FW:89082), resolve a colecao no pai (FW:89090) e desserializa com o `Loader` normal do OML (`Execute(index, fullSignature, () => ownerESpace, ... LoadChildren ...)`, FW:89104-89107).
- `Oml.GetSignatureReader(byte[])` (MI:20677-20688) le um XML FastInfoset; o inverso e `Oml.SerializeSignature(XElement)` (MI:20667-20675) e `Oml.GetSignature()` (MI:20661-20665) devolve o fragmento de assinatura de um OML.

### 1.4 De onde o Studio tira o `ReferenceInfo` (e o que o headless deve fazer)

- No Studio o delegate passado a `InitializeSignatureDeserializer` (PRS:226309-226335) chama `GetReferenceInfo(key, ct)` por chave (PRS:226319), que consulta o catalogo em memoria `prs#mcalgvfz` (dicionario `ObjectKey -> ReferenceInfo`, preenchido em PRS:226304-226307 a partir de `prs#gikpnecd`, PRS:226627-226660) e, se `SignatureBinary` vier vazio, chama `ReferenceCacheManager.Instance.RefreshReferenceDetails(IReferencesService, ref value, ...)` (PRS:226604).
- `ReferenceCacheManager.RefreshReferenceDetails` (SC:4056-4086) -> `ReferenceCache.sco#laadnway` (SC:3770-3815) -> **`IReferencesService.RefreshReferenceDetails(key.DatabaseValue(), kind, ct)`** (SC:3805). Ou seja, a fonte final e a interface `IReferencesService` (API:3338-3347): `LoginInfo`, `ListReferenceableMigratedToServerApi`, `ListReferenceable(espaceKey, appKey, ct)`, `RefreshReferenceDetails(referenceKey, referenceKind, ct)`.
- Com `Settings.Instance.DisableReferenceCache = true` o cache em disco e ignorado (`GetReferenceCache` devolve `new ReferenceCache(text, null)`, SC:4106-4108); o `RefreshReferences` do Model API faz exatamente isso (PRS:153541).
- **Prova de que se pode alimentar com um `IReferencesService` proprio:** o proprio Model API o faz. A classe `prs#lwyykvce : IReferencesService` (PRS:153293-153365) converte `IModuleSignature -> ReferenceInfo` (PRS:153334-153351: `Key = ObjectKey.Parse(ModuleKey)`, `Kind = ModuleKind.ToString()`, `SignatureHash`, `SignatureBinary`, `RuntimeKind = (SegmentationKind)ModuleType`, `AppKey = ObjectKey.Parse(ApplicationKey)`), `ListReferenceable` devolve os valores do dicionario (PRS:153353-153356), `RefreshReferenceDetails` devolve a entrada pela chave (PRS:153358-153364) e `LoginInfo => new DefaultExtendedLoginInfo()` (PRS:153327).

**Resposta:** a assinatura NAO vem de um OML do produtor; vem do `SignatureBinary` do catalogo do Service Center (`GetReferenceDetails` REST/SOAP), via `IReferencesService`. O que `HeadlessSession.GetReferenceSignature` ja devolve (`OutSystems.Communication.ServiceCenter.ReferenceInfo` com `SignatureBinary`, ANV/HeadlessSession.cs:226-243) e suficiente: basta empacotar numa `ServiceStudio.ServerCommunications.API.ReferenceInfo` (mesmo mapeamento de PRS:153336-153350; o `ModuleSignatureAdapter` de ANV/ReferenceRefresher.cs:138-157 ja tem todos os campos) e servir por um `IReferencesService` proprio. Um OML do produtor carregado headless NAO serve diretamente para `LoadSignatures`; serviria apenas para o caminho B (secao 4) ou para gerar o binario com `Oml.GetSignature()`/`SerializeSignature` (MI:20661-20675) depois de `Save()` (FW:823042-823046 mostra o Studio a fazer `eSpace.Save(); ((ESpace)eSpace).Oml.GetSignature()`), o que exige o produtor valido e e equivalente ao que o servidor calcula.

---

## 2. Como o Studio materializa as referencias no ESpace local ao clicar Apply

### 2.1 Cadeia de chamadas

1. `AddRemoveReferencesPresenter.Apply()` (PRS:11735-11800) -> dentro de `Command.Execute` + `DoVerySlowOperation` chama **`referencesManager.CommitRefreshReferences(...)`** (PRS:11768, 11774 ou 11781, conforme feature flags). O presenter/view nao faz nada alem disso.
2. `ReferencesManager.CommitRefreshReferences(string commandName = "Manage Dependencies")` (PRS:227297-227403), publico. Dentro de `GetLocker(...).DoWriteOperation` (PRS:227304):
   - `prs#gikpneci()` (PRS:226773-226791): desmarca merge units `HiddenWhenIndirectlyReferenced` que nao ficaram checked;
   - `prs#gikpnecj(...)` (PRS:226793-226814): propaga checks para dependencias registadas em `prs#mcalgvfl`;
   - `RegisterActionForBeforeRefreshState` x2 (PRS:227318-227327): renomeia elementos criados para o nome do produtor (`prs#gikpnecl`, PRS:226825-226839);
   - `prs#gikpnech(match do self-reference)` se existir (PRS:227329-227334);
   - copia `ReferenceHash` foreign -> local para roots `InBothESpaces` com `Decoration.WillBeRefreshed` (PRS:227337-227343);
   - **`prs#gikpnecv(MatchTree)` (PRS:227405-227419): `TreatMergeAsModification = true; IsProgrammaticMerge = true; pcr.Merge(); ClearCurrentMergeState(); Dispose()`** -- e aqui que os objetos `Reference`, `ReferenceEntity`, `ReferenceWebBlock`, ... sao criados no ESpace local;
   - pos-merge: limpeza de entidades nao permitidas em libraries (PRS:227356-227367) e `Verify()`.
   - Se ja houver comando aberto so muda a descricao (PRS:227393-227397); senao abre `Command.Execute(GetPresenterContext(), commandName, action)` (PRS:227400).
3. `MatchTree.Merge()` (FW:28937-29020+): passos `RemoveObjectsFromScope`, **`CreateObjects`** (FW:28948-28951), `MergeProperties`, `MergeMergeableProperties`, `DeleteObjects`, **`AcknowledgeNewTopLevelReferenceElements`** (FW:28967-28970), `AcknowledgeNewChildren`, eventos, `MergeSynthesizedProperties`, `BeforeRefreshState` (executa as acoes registadas, FW:29017-29020).

**Resposta:** nao ha metodo "copia Reference"; a materializacao E o merge de 3 vias/2 vias `MatchTree` entre o ESpace local (`localRoot`) e o `ReferencesESpace` "Dummy_ARR" (`foreignRoot`), com `MergeAction.Create` nos matches escolhidos.

### 2.2 Como o `MatchTree` e montado e como um elemento fica "checked"

- `InitializeAddReferences(ct, IEnumerable<ObjectKey> references)` (PRS:226397-226400) -> `prs#gikpnebx(new Reference[0], ReferencesESpace.References.ToArray(), references.ToArray(), ct)` (PRS:226417-226434):
  - `ReferencesESpace.LoadSignatures(presenter, keys, ct)` (PRS:226420);
  - `prs#gikpnecb` copia `ShowTenantIdentifier` de entidades multitenant ja referenciadas (PRS:226503-226512);
  - **`prs#bdibneee = new MatchTree(prs#gikpnece)`** (PRS:226426; ctor `MatchTree(Func<PropertyPair,bool> skipProperty)` FW:28690-28693; o `skipProperty` PRS:226662-226700 ignora `ShowTenantIdentifier`, `Name` renomeado localmente, labels de extensao, etc.);
  - `prs#gikpneby` trata self-reference (PRS:226436-226450);
  - **`prs#bdibneee.SetESpaces(localESpace, ReferencesESpace, null)`** (PRS:226428; FW:28817-28820 cria o `RootAtESpace`);
  - `prs#gikpneca` (PRS:226471-226501): para cada `Reference` local procura o foreign de mesma `ReferenceKey` e faz `AddRoot(local, foreign, null, resetMatches: true)` (PRS:226495; FW:28822-28876); para foreigns sem local faz `AddRoot(null, foreign, null)` (PRS:226485-226488) -- e assim que um **produtor ainda nao referenciado** aparece como root `InForeignESpaceOnly`.
- `ReferencesManager.SetIsChecked(Match match, bool value)` (PRS:227103-227130, publico) enfileira e chama `ProcessPendingChecks()` (PRS:227149-227179) -> `prs#gikpnecm/prs#gikpnecn` (PRS:226841-226943): valida `IsUnavailable`/`IsAllowed`/`IsAllowedInRuntimeKind` (PRS:226856-226883), aplica `prs#gikpnecs` (PRS:227048-227078) que traduz o check em `MergeAction`: `InForeignESpaceOnly -> Create`, `InLocalESpaceOnly -> Delete`, `InBothESpaces -> Update` (PRS:227054-227067 em modo refresh; PRS:227070-227077 em modo check/uncheck); recursa em filhos, propriedades e dependencias (web block -> source block PRS:226894-226897; referers via `prs#gikpnecr`). Depois, se for reference unit, `prs#gikpnect` descobre dependencias transitivas (`ReferenceUtils.GetDependentReferenceUnits`, PRS:227191) e, com `UncheckBehavior.Uncheck`, marca-as tambem (PRS:227209-227227).
- O flow programatico do proprio Studio (usado por "add dependency" a partir de um elemento publico escolhido, PRS:171321-171333 e PRS:100717-100729) e a prova viva da sequencia sem dialogo aberto pelo utilizador:

```csharp
// PRS:101098-101165
using ReferencesManager referencesManager = new ReferencesManager(aggregator, espace);      // PRS:101103 (ctor PRS:226256-226264)
referencesManager.prs#gikpneds(sln: true, default, out _, null);                          // PRS:101104 = inicializacao com skipInitialization:true (PRS:226280-226369)
referencesManager.InitializeAddReferences(default, producerKeys);                          // PRS:101105
IAddRemoveReferencesPresenter p = ...CreateView<IAddRemoveReferencesView>()...;            // PRS:101106 (PRS:12963-12967) -- so para navegar na arvore
Match match = p.FindProducerMatch(producerKey);                                            // PRS:101114 -> PRS:11691-11694: Roots.SingleOrDefault(re => (re.AnyObject as Reference).ReferenceKey == producerKey)
p.ReferenceTreePresenter.AddRoots(match.ToEnumerable());                                   // PRS:101120 (so UI)
Match match2 = p.FindMatchElementByKey(match, elementKey);                                 // PRS:101123 -> PRS:11676-11689: producer.GetAllChildren() com ITopLevelReferenceElement.OriginalKey == elementKey
p.SetIsChecked(match2, value: true);                                                       // PRS:101129 -> PRS:11715-11718 -> ReferenceTreePresenter.TriggerSetIsChecked -> ReferencesManager.SetIsChecked
referencesManager.CommitRefreshReferences("...");                                          // PRS:101138
```

Tudo o que o `IAddRemoveReferencesPresenter` faz ai e navegacao (`Roots`, `GetAllChildren`, `AnyObject`, `OriginalKey`) e pode ser reproduzido sem view: `MatchTree.Roots` (FW:28578), `Match.GetAllChildren()` (FW:27068), `Match.AnyObject` (FW:26369), `Match.MatchType` (FW:26201), `Match.Children` (FW:26336), `AbstractObject.Match` (FW:30306) sao publicos.

### 2.3 Requisitos de thread/presenter

- `ReferencesManager` precisa de um `ITopLevelPresenter`/`IAggregatorPresenter`: usa `ApplicationInformationService` (PRS:226260), `ServerCommunicationsProvider.LoginInfo?.HostInfo.HostName` (PRS:226261, null-safe), `ServerCommunicationsProvider.ReferencesService` **apenas se nao for passado um `IReferencesService`** (PRS:226282), `GetLoggers().ReferencesManagerLogger` (PRS:226335, 226597), `GetPresenterContext()` (PRS:227400), `ServerCommunicationsProvider?.ServerLicensingInfo` (PRS:227444 e 229261, null-safe). `MockAggregatorPresenter(espace, null, registerAsStaticInstance:false)` (PRS:210610-210645) fornece tudo isto: cria `ServerCommunicationsProvider.GetNewInstance(this)` (PRS:210617), `ApplicationInformationService` lazy (PRS:210448-210454) e `GetPresenterContext` (PRS:210693). E o mesmo mock que o Model API usa (PRS:153525-153527) e que o Anvil ja usa (ANV/HeadlessRuntime.cs:81-86, ANV/Publisher.cs:140-148).
- `Runtime.Instance.Recorder.IsActive` (PRS:227105) - `Recorder` e inicializado no ctor do Runtime (FW:2549).
- `Settings.Instance` (PRS:227446, 226636) - inicializado em ANV/HeadlessRuntime.cs:40-43.
- Nao ha dependencia de UI thread: `Apply()` do presenter corre em `DoVerySlowOperation` (thread de background) e o manager protege-se com `GetLocker(...).DoWriteOperation` (PRS:227304).
- O merge exige `Runtime.GetAggregator(espace).DeveloperId` (nota em ANV/HeadlessRuntime.cs:79-80), coberto por `SsamHeadlessRuntime.GetAggregator` (ANV/HeadlessRuntime.cs:82-86).

---

## 3. `RefreshReferences` adiciona ou so atualiza?

**So atualiza.** Cadeia:

1. `IESpace.RefreshReferences(...)` (V1:478; FW:101781-101784) -> `ICommandServices.RefreshReferences` (V1:205) implementado em `prs#bvugoeve : Service, ICommandServices` (PRS:153291), metodo `RefreshReferences(IESpace, IEnumerable<IModuleSignature>, IKey ownerApplicationKey, string ownerDatabaseName)` (PRS:153530-153552):
   - cria o `IReferencesService` a partir das assinaturas (PRS:153533) e opcionalmente o `IApplicationInformationService` (PRS:153535-153538);
   - `hashSet` = chaves dos produtores fornecidos (PRS:153539);
   - `Settings.Instance.DisableReferenceCache = true` (PRS:153541);
   - dentro de `prs#drgebrbi` (= `PrepareForCommandExecution` + `MockAggregatorPresenter` + `MockPresenter`, PRS:153504-153528) chama **`ReferencesManager.RefreshAllReferences(aggregator, espace, provider, appInfo, skipProducer: r => !hashSet.Contains(r.ReferenceKey))`** (PRS:153545).
2. `RefreshAllReferences` (PRS:227251-227275): `new ReferencesManager(aggregator, espace, skipInitialization: false, ...)` (PRS:227260) -> `UncheckBehavior.Uncheck` -> **para cada root do MatchTree** que nao seja skip: `flag |= prs#gikpnecu(root, aggregator)` (PRS:227264-227267) -> se `flag`, `CommitRefreshReferences` (PRS:227270).
3. Com `skipInitialization: false`, a arvore e montada por `prs#gikpnebw` (PRS:226402-226415): `array3` = **chaves das `Reference` que JA existem no ESpace local** (PRS:226408-226410: `from pec in localESpace.References where ReferenceKind != Unknown select ReferenceKey`), menos as em cache de decoracao e as ja carregadas. So essas sao passadas a `LoadSignatures` (PRS:226420). Um produtor que esteja nas `producerModuleSignatures` mas nao esteja em `localESpace.References` **nunca e carregado nem vira root**.
4. `prs#gikpnecu(Match, aggregator)` (PRS:227237-227249): `if (MatchType != InForeignESpaceOnly && Decorate(...) in {IncompatibleReference, ModifiedReference}) { recursa nos filhos; Refresh(match); return true; }`. Roots `InForeignESpaceOnly` sao explicitamente ignorados.
5. `Refresh(match)` (PRS:227132-227147) enfileira com `pbn = true` (modo refresh). Em modo refresh, `prs#gikpnecn` so desce a filhos top-level que **ja estejam checked** (PRS:226907-226913: `!(GetObject() is ITopLevelReferenceElement) || (IsChecked(child) && (...)) || IsUnavailableAndIncompatible(child)`), e `ReferenceUtils.IsChecked` e `false` para `InForeignESpaceOnly` sem MergeAction (PRS:229268-229283). Logo elementos novos do produtor (entidades/acoes que o consumidor ainda nao referencia) nao ganham `MergeAction.Create`; so elementos ja referenciados sao atualizados (`InBothESpaces -> Update`, PRS:227062-227064) ou removidos se desapareceram (`InLocalESpaceOnly -> Delete`, PRS:227056-227058).

Conclusao: `RefreshReferences` com assinatura completa **nao adiciona** novos produtores nem novos elementos; atualiza (ou apaga) apenas o que ja esta referenciado. Isto e coerente com o que o Anvil observou (`ReferenceRefresher.Refresh` so muda `Changed` quando ha staleness, ANV/ReferenceRefresher.cs:56-98).

Nota: o comentario em ANV/ReferenceRefresher.cs:24-26 diz que `RefreshReferences` "roda o mesmo `ReferencesManager.RefreshAllReferences`" -- confirmado em PRS:153545.

---

## 4. Caminho direto pelas classes do Framework (produtor carregado como `ESpace`)

### 4.1 Model API publica (V1) que ja faz "add"

`IESpace` (V1:464-472) expoe:

```csharp
SignatureT AddDependency<ConcreteT, SignatureT>(IShareable<ConcreteT, SignatureT> sourceObj);   // V1:464
void RefreshDependencies(params IShareable[] sourceElements);                                   // V1:466
void RefreshDependencies(IEnumerable<IShareable> sourceElements);                               // V1:468
void RefreshDependencies(params IESpace[] sourceESpaces);                                       // V1:470
void RefreshDependencies(IEnumerable<IESpace> sourceESpaces);                                   // V1:472
IActionSignature AddDependency(OutSystems.Model.Extensions.IAction sourceAction);              // V1:476 (extensoes XIF)
```

Implementacoes no Framework:

- `IESpace.AddDependency<ConcreteT,SignatureT>` (FW:101751-101754) -> `ESpaceServicesImplementation.AddDependency(target, sourceObj)` (FW:823013-823017): `CheckIsValidDependency` (FW:823005-823011: **`Public` obrigatorio, ESpace diferente, `sourceObj.IsValid` obrigatorio**) e depois `AddAsReferenceToAnotherESpace(sourceElem, targetESpace)` (FW:823019-823031): se ja existe um `ITopLevelReferenceElement` com o mesmo `GlobalKey` e nao esta `Hidden`, devolve-o; se esta hidden, apaga-o e recria; senao **`sourceElem.AddAsReferenceToAnotherESpace<IObject>(targetESpace)`** (FW:612245-612248) -> `InnerCloneToAnotherESpace` (FW:612250-612260): valida (`element is ITopLevelReferenceElement || ITopLevelReferenceableElement`), calcula `GlobalCompoundKey.Create(element).GetDeepestCompatibleParent(ownerESpace, targetESpace)` (FW:612257; FW:776638-776662 -- devolve o `Reference` ja existente para aquele produtor, se houver) e faz **`ObjectCloner.CloneObject(element, newParent ?? targetESpace.GetImportTargetRestrictedToReferences())`** (FW:612258-612259; `GetImportTargetRestrictedToReferences` FW:104413-104420 = import target cuja unica colecao e `References`, FW:86713-86725).
- `IESpace.RefreshDependencies(IEnumerable<IShareable>)` (FW:101761-101764) -> FW:823033-823040 (valida cada um com `CheckIsValidDependency`) -> **`RefreshDependencies(IESpace target, IEnumerable<ITopLevelReferenceableElement>)` (FW:823109-823132)**: cria `ESpace.CreateForRefreshReferences` ("Dummy_ARR"), clona cada elemento do produtor para la com `AddAsReferenceToAnotherESpace` (FW:823120-823123), monta `new MatchTree(targetESpace, dummy)` (FW:823124; ctor FW:28622-28625 -> FW:28637-28688, 2 vias porque `baseRoot == null && localRoot is ESpace`, FW:28643-28652), `IsProgrammaticMerge = TreatMergeAsModification = true` (FW:823125-823126), **`MergeUtils.SetIsChecked(item.Match, true, checkDependencies: true, checkAllChildren: true)`** por elemento (FW:823129; FW:29643-29700) e `matchTree.Merge()` (FW:823131). `CheckMergeElementToBoth` da `MergeAction.Create` a `InForeignESpaceOnly` (FW:29900-29902), logo **este verbo ADICIONA elementos ainda nao referenciados** (e refresca os existentes) com resolucao de dependencias -- e o "Apply" do Manage Dependencies em versao Model API, sem servidor.
- `IESpace.RefreshDependencies(IEnumerable<IESpace>)` (FW:101771-101774 -> FW:823048-823107) so refresca elementos **ja referenciados** e desatualizados (`IsOutdated` compara `FullSignatureHash` com a assinatura gerada por `eSpace.Save(); Oml.GetSignature()`, FW:823042-823046 e 823103-823106), e ainda atualiza `Name/Description/Icon/JQueryVersion` das `Reference` (FW:823061-823068). Exige todos os produtores `IsValid` (FW:823051-823052).

### 4.2 Como o clone cria/liga o `Reference` (chave e hash)

- O `ObjectCloner.CloneObject(source, newParent)` (FW:845870-845873 -> `TryCloneObject` FW:845936-845977) escolhe uma `IKindConversion` permitida pelo target (`CloneAllowed`, FW:845856-845868). Para entidade: `Entity.FromEntityToReferenceConversion : FromTopLevelReferenceableElementToReferenceConversion` com `TargetKind = Reference.Kind` e `PerceivedTargetKind = ReferenceEntity.Kind` (FW:82029-82036). Ha conversoes equivalentes para Structure (FW:422081), Role (FW:416063), UserAction/ServerAction (FW:144854), ServiceAPIMethod (FW:143163), WebBlock web e reactive (FW:263591, 320508), WebScreen (FW:271362, 324733), ClientAction (FW:297249), Theme (FW:434119, 820521), Image (FW:414621 Resource, 214283 Image), Script (FW:419001), Process (FW:119402), etc.
- `FromTopLevelReferenceableElementToReferenceConversion.Convert` (FW:37043-37048) faz `converter.LoadDefaultDataFromDifferentSource(this, obj, <raiz do produtor = ESpace>)` e `ConvertAgainToNewParent`; `IsAllowed` exige `ReferenceOriginAdditionalData.GetSourceESpace() != null` (FW:37050-37062), i.e. o produtor tem de estar **registado em `ESpaceInstances`** (FW:39176-39179), o que `ESpace.Load` garante (ctor FW:102404-102422 chama `ESpaceInstances.AddEspace`).
- `LoadDefaultDataFromDifferentSource` (FW:845735-845759) aplica `FromESpaceToReferenceConversion` (FW:86198-86225): **`ReferenceKey <- ESpace.Key`** (FW:86214), `EspaceType`/`ReferenceType` forcados (FW:86216-86217), `ReferenceKind = eSpace` (FW:86209). **Nao ha mapeamento para `ReferenceHash`** -> fica `Guid.Empty`. Os `FullSignatureHash`/`CompatibilitySignatureHash` do elemento sao preenchidos pelo import (`ImportExtensions` FW:37794-37802).
- O `Reference` novo recebe `ReferenceSentinel` em `InnerRefreshState` (FW:378996-379007).

### 4.3 Construtores publicos (para o caminho C, nao recomendado)

- `Reference(ESpace parent, string name)` (FW:378185-378188) / `Reference(IParent<Reference>, string)` (FW:378190-378204); `[ModelAPIConstructor] internal Reference(IParent<Reference>, ObjectKey, string)` (FW:378217-378232). Propriedades publicas com setter: `ReferenceKey` (FW:374325), `ReferenceKind` (FW:374337), `ReferenceHash` (FW:374349), `EspaceType` (FW:374385), `ReferenceType` (FW:374397), `HasDeserializationErrors` (FW:374966). O Studio usa exatamente isto no `SignatureDeserializer` (FW:89004-89015) e no `AddDependency(IAction)` de extensoes (FW:101898-101905).
- `ReferenceEntity(Reference parent, string name, ObjectKey originalKey, string originalName, bool isStaticEntity, bool isClientEntity)` (FW:384880), sobrecargas FW:385686 e FW:385691; `ReferenceAction(Reference parent, string name, ObjectKey originalKey)` (FW:379802); `ReferenceStructure(Reference parent, string name, ObjectKey originalKey, string originalName)` (FW:401796); `ReferenceWebBlock(ReferenceWebFlow parent, string name, ObjectKey originalKey)` (FW:408407 web, FW:815365 reactive). Os filhos (atributos, parametros, placeholders, `EntityIdentifierType`, anonymous structures) teriam de ser criados a mao e `ITopLevelReferenceElement.FullSignatureHash/CompatibilitySignatureHash/Hidden` (FW:806929-806944) preenchidos -- sem isso o `IsOutdated`/staleness e o refresh futuro ficam errados. Por isso C fica fora do plano.

---

## 5. Plano de implementacao headless (C#)

### 5.1 Opcao A (recomendada): `ReferencesManager` sem view, alimentado pelo Service Center

Pre-condicoes ja existentes no Anvil: `HeadlessRuntime.Ensure` (ANV/HeadlessRuntime.cs:30-69), `ModelHost.Load/Save` (ANV/ModelHost.cs:20-29), `HeadlessSession.ListReferenceable`/`GetReferenceSignature` (ANV/HeadlessSession.cs:139-146, 226-243), `Publisher.Mutate` (ANV/Publisher.cs:140-148).

Passos:

1. **Catalogo + assinaturas como `IReferencesService`.** Nova classe `CatalogReferencesService : ServiceStudio.ServerCommunications.API.IReferencesService` (API:3338-3347):
   - `LoginInfo => new DefaultExtendedLoginInfo()` (como PRS:153327; `Hostname = LoginInfo.HostInfo.HostName` e lido em PRS:226283, logo nao pode ser null);
   - `ListReferenceableMigratedToServerApi => true` (ou false; nao e lido pelo manager);
   - `ListReferenceable(espaceKey, appKey, ct)` -> mapear `HeadlessSession.ListReferenceable()` (ANV/HeadlessSession.cs:139-146) para `API.ReferenceInfo { Key = ObjectKey.Parse(Key), Name, Kind ("eSpace"/"Extension"), SignatureHash = Guid, Is_System = IsSystem?1:0, AppKey }` **sem** `SignatureBinary` (o manager pede o detalhe depois, PRS:226599-226604). O `MustBeTrue` de PRS:226639 exige `Kind` valido para todos os itens (ou `Key == Constants.UnknownESpaceKey`).
   - `RefreshReferenceDetails(referenceKey, referenceKind, ct)` -> `HeadlessSession.GetReferenceSignature(referenceKey, referenceKind)` e converter `OutSystems.Communication.ServiceCenter.ReferenceInfo` -> `API.ReferenceInfo` com o mesmo mapeamento de PRS:153336-153350 (`SignatureBinary`, `SignatureHash`, `RuntimeKind`, `AppKey`, `Icon`, `JQueryVersion`, `ExtensibilityConfiguration`), `IsOperationStatusOk = true`. Atencao: o manager passa `key.DatabaseValue()` (SC:3805); `GetReferenceSignature` ja converte para forma DB (ANV/HeadlessSession.cs:231).
   - Servir **qualquer** chave, incluindo `Constants.ServiceCenterESpaceKey` ("(System)"): o desserializador pede-a quando o produtor usa roles/processes (FW:88848-88851, 89091-89094) e o manager pede-a na inicializacao (PRS:226341).
2. **`IApplicationInformationService`** (opcional mas recomendado): implementar `AreFromSameApp`, `GetModuleApplicationKey`, `GetModuleDatabaseName` como PRS:153386-153410 a partir do catalogo (AppKey por modulo; nome da base por app se conhecido, senao `Constants.SystemDatabaseName`). Sem ele o manager usa `MockAggregatorPresenter.ApplicationInformationService` (PRS:226260, PRS:210448-210454), que consulta `ServerApplicationsInfo` do provider mock -- funcionou no `RefreshReferences` do Anvil, mas os decoradores `IsAllowed`/`AreFromSameApp` (PRS:228789-228811) sao mais fieis com o catalogo real.
3. **Sequencia por consumidor** (um `Command` por lote de referencias):

```csharp
Settings.Instance.DisableReferenceCache = true;                                        // PRS:153541; SC:4106-4108
var consumer = host.Load(consumerOml);                                                 // ANV/ModelHost.cs:20-23
Publisher.Mutate(consumer, "SSHeadless: add references", e =>                          // ANV/Publisher.cs:140-148 (PrepareForSave + MockAggregatorPresenter + MockPresenter + Command.Execute)
{
    var aggregator = /* o MockAggregatorPresenter criado em Mutate; expor via parametro */;
    using var rm = new ReferencesManager(aggregator, e, skipInitialization: true, ct,
                                         applicationInformationService: appInfo, provider: catalogSvc, decorationCache: null); // PRS:226250-226254 -> PRS:226280-226369
    if (rm.WasCancelled) throw ...;                                                    // PRS:226236-226248
    rm.UncheckBehavior = UncheckBehavior.Uncheck;                                      // PRS:229403-229408; evita ShowMessage (PRS:227209-227216)
    rm.InitializeAddReferences(ct, producerKeys);                                      // PRS:226397-226400
    var tree = (MatchTree)typeof(ReferencesManager).GetProperties(BindingFlags.NonPublic|BindingFlags.Instance)
                 .Single(p => p.PropertyType == typeof(MatchTree)).GetValue(rm);       // PRS:226139-226151 (internal, nome ofuscado)
    foreach (var (producerKey, elementKeys) in request)
    {
        var producer = tree.Roots.SingleOrDefault(m => (m.AnyObject as Reference)?.ReferenceKey == producerKey)   // PRS:11691-11694; FW:28578, FW:26369
                       ?? throw new InvalidOperationException("producer not in catalog / not loaded");
        if (ReferenceUtils.IsReferenceWithLoadErrors(producer)) throw ...;             // PRS:229296
        foreach (var k in elementKeys)
        {
            var el = producer.GetAllChildren().FirstOrDefault(m => m.AnyObject is ITopLevelReferenceElement t && t.OriginalKey == k) // PRS:11676-11689; FW:27068
                     ?? throw new InvalidOperationException("element not public in producer signature");
            rm.SetIsChecked(el, true);                                                 // PRS:227103-227130
        }
    }
    rm.CommitRefreshReferences("SSHeadless: add references");                          // PRS:227297-227403 (ja dentro de comando: PRS:227393-227397)
});
var messages = consumer.Verify();                                                      // FW: ESpace.Verify (usado em ANV/ModelHost.cs:132)
File.WriteAllBytes(outPath, host.Save(consumer));                                      // ANV/ModelHost.cs:25-29
```

   Alternativa sem reflexao para `prs#bdibneee`: o `Reference` foreign esta em `rm.ReferencesESpace.References` (PRS:226180) e `AbstractObject.Match` e publico (FW:30306), logo `rm.ReferencesESpace.References.Single(r => r.ReferenceKey == producerKey).Match` da o root diretamente (e o padrao de PRS:227332 e FW:823129).

4. **Selecao por nome** (ergonomia): resolver `elementKey` a partir de `producer.GetAllChildren()` filtrando `AnyObject is ITopLevelReferenceElement` e comparando `AnyObject.Name` / `OriginalName` (`IObjectWithOriginalName`, FW:806929), e o tipo (`ReferenceEntity`, `ReferenceAction`, `ReferenceWebBlock`, `ReferenceStructure`, `ReferenceRole`, `ReferenceClientAction`, `ReferenceServiceAPIMethod` -- lista de `IParent<...>` de `Reference` em FW:373525).
5. **Idempotencia / remocao**: `SetIsChecked(match, false)` em `InBothESpaces` produz `MergeAction.Delete` (PRS:227070-227073) -> serve para "remove dependency". Um elemento ja referenciado aparece como `InBothESpaces` com `IsChecked == true` (PRS:229274-229282); marcar de novo e no-op.
6. **Refresh no mesmo passo**: com `skipInitialization:false` o manager carrega todos os produtores ja referenciados (PRS:226402-226415) e `RefreshAllReferences`-like pode ser feito chamando `rm.Refresh(root)` (PRS:227132-227147) nos roots com `Decorate(...)` em `{IncompatibleReference, ModifiedReference}` (PRS:227239); `ReferenceUtils.Decorate` e publico (PRS:229223) e o enum `Decoration` esta em VIEW:3791.

Reflexao necessaria na opcao A:
- `ESpace.PrepareForSave` (internal; ja feito em ANV/Publisher.cs:143-144; equivalente publico via `IESpaceServices.PrepareForCommandExecution`, FW:822982-822985);
- `ReferencesManager.prs#bdibneee` (internal `MatchTree`, PRS:226139) -- ou evitar via `Reference.Match` (FW:30306);
- nada mais: `ReferencesManager` (PRS:224787), os seus ctors (PRS:226250, 226256), `InitializeAddReferences` (226397), `SetIsChecked` (227103), `Refresh` (227132), `CommitRefreshReferences` (227297), `ReferencesESpace` (226180), `WasCancelled` (226236), `UncheckBehavior` (226222), `MockAggregatorPresenter` (PRS:209760), `MockPresenter`, `Command.Execute`, `MatchTree`/`Match` (FW:28530, FW:26201-27068), `ReferenceUtils` (PRS:227896) e `IReferencesService`/`ReferenceInfo` (API:3338, 3254) sao publicos.

Riscos e mitigacoes (opcao A):
- `prs#gikpnecd` filtra o catalogo com `Settings.Instance.AllowProtectedESpacesAndExtensions(key) || prs#mcalgvfj.prs#xpybsnvx(info, ServerApplicationsInfo)` (PRS:226636). O mock tem `ServerCommunicationsProvider` nao nulo (PRS:210617) e o mesmo caminho corre no `RefreshReferences` ja provado; se um produtor for filtrado, o `Roots.SingleOrDefault` devolve null -> erro claro.
- `CommunicationException` no catalogo mostra `Runtime.Instance.ShowPlatformServerMessage` (PRS:226294-226299): com `Runtime.DummyImplementation` nao ha dialogo; converter as excecoes do `HeadlessSession` em `ReferenceInfo` ausente e verificar `WasCancelled`.
- `SignatureBinary` vazio -> `HasDeserializationErrors` (FW:89019-89035) -> root com load errors; verificar com `ReferenceUtils.IsReferenceWithLoadErrors` (PRS:229296) antes do commit.
- Produtor que referencia terceiros nao carregados: o desserializador pede-os ao delegate (FW:88854-88869); se o servico nao os devolver ficam `Unavailable` (FW:89185-89197) e o `SetIsChecked` pode desmarcar por `IsUnavailableAndIncompatible` (PRS:226856-226869). Mitigacao: o servico serve qualquer chave.
- Regras de runtime (`IsAllowedInRuntimeKind`, PRS:226880-226883; `IsAllowed` PRS:228789-228811): e.g. entidade server num modulo Reactive vem via service action, nao como `ReferenceEntity` server-side; o manager desmarca silenciosamente (`pbq=false`). Detetar comparando `ReferenceUtils.IsChecked(el)` (PRS:229268) depois de `SetIsChecked` e falhar com mensagem.
- Telemetria: `SSTelemetry.Statistics.Generic` (PRS:227362, 227368) -- ja tolerado pelo prologo do Anvil (`ILoggersProvider`/`ITracerProvider` no-op, ANV/HeadlessRuntime.cs:44-45).
- Memoria/tempo: `LoadSignatures` de produtores grandes (ex.: "(System)") custa segundos; o `Dummy_ARR` e fechado no `Dispose` do manager (PRS:227479-227487).

### 5.2 Opcao B: Model API com o produtor carregado headless (sem servidor)

```csharp
var producer = host.Load(producerOml);                       // ESpace registado (necessario: FW:37050-37062, FW:39176-39179)
producer.Verify(); if (!producer.IsValid) throw ...;         // CheckIsValidDependency exige IsValid (FW:823010)
var consumer = host.Load(consumerOml);
Publisher.Mutate(consumer, "SSHeadless: add references", e =>
{
    var es = (OutSystems.Model.IESpace)e;
    var entity = ((OutSystems.Model.IESpace)producer).Entities.Single(x => x.Name == "Customer");   // IShareable<IEntity, IEntitySignature> (FW:81894)
    es.RefreshDependencies(new OutSystems.Model.IShareable[] { entity });                          // V1:466 -> FW:823033-823040 -> FW:823109-823132 (clone + MatchTree + SetIsChecked(true, deps, children) + Merge)
    // ou: var refEntity = es.AddDependency(entity);                                                // V1:464 -> FW:823013-823031 (clone direto, sem merge; sem dependencias transitivas)
});
```

- Vantagens: publico, sem reflexao, sem rede, resolve dependencias do elemento (`checkDependencies: true`, FW:823129) e serve para atualizar o que ja existe.
- Limitacoes: (1) o `Reference` novo fica com `ReferenceHash == Guid.Empty` (nao ha mapeamento em FW:86212-86219) -> aparece "stale" no `ReferenceRefresher.Staleness` (ANV/ReferenceRefresher.cs:31-48) e o publish do consumidor pode exigir refresh; corrigir com `reference.ReferenceHash = catalog.SignatureHash` (setter publico FW:374349) ou correr `RefreshReferences` a seguir; (2) exige o OML do produtor **na mesma versao publicada** (senao os `FullSignatureHash` divergem do servidor); (3) o produtor tem de ser valido e ficar vivo (registado) ate ao fim do clone.

### 5.3 Opcao C (descartada)

Construir `Reference`/`ReferenceEntity`/... a mao (secao 4.3): sem `FullSignatureHash`/`CompatibilitySignatureHash`, sem `EntityIdentifierType`/anonymous structures, sem `AcknowledgeNewTopLevelReferenceElements`. So justificavel para uma extensao XIF (`IESpace.AddDependency(IAction)`, FW:101893+), que o Studio ja cobre.

### 5.4 Validacao: 1 entidade de `Headless_CS` em `Headless_UI`, Verify sem erros

1. `HeadlessSession.Connect` -> `FindModule("Headless_CS")` e `FindModule("Headless_UI")`; `Download` dos dois (ANV/HeadlessSession.cs:270-303).
2. Baseline: `ModelHost.Describe(consumer)` -> `Validation.Total`, e `References` (ANV/ModelHost.cs:126-157); confirmar que `Headless_CS` **nao** esta em `consumer.References` (ou esta sem a entidade).
3. Descobrir a chave da entidade no produtor: (a) `ListReferenceable()` da a `Key` do modulo; (b) a `OriginalKey` do elemento vem da assinatura -- na opcao A obtem-se navegando `producerMatch.GetAllChildren()` por nome (`AnyObject.Name == "Customer"`), sem precisar do OML do produtor.
4. Correr a opcao A com `producerKeys = [Headless_CS key]` e o elemento `Customer`.
5. Asserts pos-commit (todos no mesmo processo, antes de salvar):
   - `consumer.References.Single(r => r.ReferenceKey == csKey)` existe, `ReferenceKind == eSpace`, `ReferenceHash == catalog.SignatureHash` (o merge copia as propriedades do `Reference` foreign criado em FW:89004-89015);
   - `reference.GetAllChildrenOfType<ReferenceEntity>().Single(x => x.Name == "Customer")` com `Hidden == false`, `FullSignatureHash != Guid.Empty`, `Attributes` nao vazios, `Parent.ReferenceKey == csKey`;
   - `consumer.Verify()` sem `Error` (comparar `Validation.Total` antes/depois; usar `ModelHost.ValidationDetails` ANV/ModelHost.cs:76-96 para listar);
   - `ReferenceRefresher.Staleness(session, consumer)` reporta `Stale == false` para `Headless_CS` (ANV/ReferenceRefresher.cs:31-48).
6. `host.Save(consumer)` -> `host.Load(bytes)` -> repetir os asserts (round-trip, ANV/ModelHost.cs:46-72).
7. Prova viva opcional: `Publisher.Publish` do OML resultante (ANV/Publisher.cs:176) e `error_logs`/`Verify` do servidor 0 erros; depois usar a entidade numa Server Action do consumidor (`Publisher.AddServerAction`, ANV/Publisher.cs:151-162) para provar que o `ReferenceEntity` esta ligado a tipos (`EntityIdentifierType`).
8. Negativos a cobrir: elemento nao publico (nao aparece na assinatura -> `FindMatchElementByKey` null), produtor ausente do catalogo (`Roots.SingleOrDefault` null), `SignatureBinary` vazio (`IsReferenceWithLoadErrors`), elemento nao permitido no runtime (`IsChecked` false apos `SetIsChecked`).

---

## 6. Indice das citacoes-chave

| Tema | Local |
|---|---|
| `ReferencesManager` classe / ctors | PRS:224787; PRS:226250-226264 |
| Inicializacao (`prs#gikpneds`): provider, catalogo, `CreateForRefreshReferences`, `InitializeSignatureDeserializer` | PRS:226280-226369 |
| `InitializeAddReferences` -> `LoadSignatures` -> `MatchTree`/`SetESpaces`/`AddRoot` | PRS:226397-226501 |
| `ESpace.LoadSignatures` / `InitializeSignatureDeserializer` | FW:105800-105810 |
| `SignatureDeserializer` (`Load`, `LoadSignatures`, `DeserializeSignature`) | FW:88777-89114 |
| `Oml.GetSignature` / `SerializeSignature` / `GetSignatureReader` | MI:20661-20688 |
| `IReferencesService`, `ReferenceInfo` | API:3338-3347; API:3254-3337 |
| `ReferenceCacheManager` (cache, `RefreshReferenceDetails`) | SC:4044-4110; SC:3770-3815 |
| `IModuleSignature -> ReferenceInfo` adapter do Model API | PRS:153293-153365 |
| `IApplicationInformationService` minimo | PRS:153367-153411 |
| `ICommandServices.RefreshReferences` impl | PRS:153530-153552 |
| `RefreshAllReferences` / `prs#gikpnecu` (so refresca) | PRS:227251-227275; PRS:227237-227249 |
| `SetIsChecked` / `Refresh` / `ProcessPendingChecks` / `prs#gikpnecs` (MergeAction) | PRS:227080-227179; PRS:227048-227078 |
| `CommitRefreshReferences` / merge (`prs#gikpnecv`) | PRS:227297-227419 |
| `AddRemoveReferencesPresenter.Apply`, `FindProducerMatch`, `FindMatchElementByKey` | PRS:11735-11800; PRS:11691-11694; PRS:11676-11689 |
| Flow programatico do Studio (add dependency sem dialogo) | PRS:101098-101165; PRS:171321-171333 |
| `MatchTree` (ctors, `SetESpaces`, `AddRoot`, `Merge`, `Roots`) | FW:28530-29020; FW:28578 |
| `MergeUtils.SetIsChecked` / `CheckMergeElementToBoth` | FW:29643-29700; FW:29889-29927 |
| `ReferenceUtils.Decorate` / `IsChecked` / `IsAllowed` / `IsReferenceUnit` | PRS:229223-229283; PRS:228789-228811; PRS:228761-228778 |
| `Decoration` enum / `UncheckBehavior` | VIEW:3791; PRS:229403-229408 |
| `MockAggregatorPresenter` | PRS:209760; PRS:210610-210645 |
| Model API `IESpace.AddDependency` / `RefreshDependencies` | V1:464-478; FW:101751-101784 |
| `ESpaceServicesImplementation.AddDependency` / `AddAsReferenceToAnotherESpace` / `RefreshDependencies` | FW:823005-823132 |
| `InnerCloneToAnotherESpace`, `GetImportTargetRestrictedToReferences` | FW:612245-612260; FW:104413-104420; FW:86713-86725 |
| `ObjectCloner.CloneObject`/`TryCloneObject`/`CloneAllowed` | FW:845856-845977 |
| Conversoes X->Reference; `FromESpaceToReferenceConversion` (ReferenceKey, sem ReferenceHash) | FW:37037-37063; FW:82029-82036; FW:86198-86225 |
| `ReferenceOriginAdditionalData` (produtor tem de estar registado) | FW:39147-39195 |
| Construtores `Reference`, `ReferenceEntity`, `ReferenceAction`, `ReferenceStructure`, `ReferenceWebBlock` | FW:378185-378232; FW:384880-384908, 385686-385691; FW:379802-379827; FW:401796-401824; FW:408407, 815365 |
| `ITopLevelReferenceElement` | FW:806929-806944 |
| `ESpace.CreateForRefreshReferences` / `CreateUnregistered` / `Close` | FW:102383-102395; FW:103214-103226 |
| Anvil: prologo, mutacao em comando, refresh existente | ANV/HeadlessRuntime.cs:30-86; ANV/Publisher.cs:140-148; ANV/ReferenceRefresher.cs:56-135 |

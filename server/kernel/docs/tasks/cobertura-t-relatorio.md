# Frente T — tipos de artefato que nunca passaram pela faixa ODC

Frente T — estado: **concluída**
Branch/worktree: `cov2/c` em `C:\Users\andre\Anvil-cov-c`; commits `79b8ed0` (os sete jobs) e
`af3b6c8` (este relatório + a linha do `docs/PROVAS.md`).
Porta: `ANVIL_ODC_PORT=4667` em toda a sessão. Faixa O11 não usada, `ANVIL_LANE` nunca definida.
Base de todos os jobs: `tests/fixtures/odc/wrightflood-personal-r8.oml` (direta ou por `job:`), headless.

A faixa ODC passou de **17 para 23 jobs** em `tests/jobs-odc` e de **2 para 3** em `tests/jobs-odc-negative`.

---

## Jobs entregues

| Job | O que prova | Espelha (O11) |
|---|---|---|
| `tests/jobs-odc/timer-action.json` | **Timer**: `ITimer` com `Action`, `Description`, `CronSchedule`, `TimeoutInMinutes`, `Priority`, e o filho `ScheduleConfiguration` (`ISchedule` com `IMinute/IHour/IMonth/IDayOfMonth/IDayOfWeek`), que o SS11 não tem. O `usages` prova que o timer conta como consumidor real da server action | `tickets-06-sla.json`, `process-human-traditional.json` (ambos só `Action` + `Description`) |
| `tests/jobs-odc/security-settings.json` | **Role**, **exceção de usuário**, **Setting** (o que o SS11 chama Site Property) — incluindo uma **Setting secreta** — e **variável de cliente**. A tela fica restrita ao role pelo conector `Roles`; as duas Settings são lidas por uma server action que levanta a exceção; a variável de cliente é lida numa expressão da tela e gravada numa screen action | `security-config-reactive.json` |
| `tests/jobs-odc/theme-script-resource.json` | **Tema** (`IMobileTheme` com `BaseTheme` e CSS de autor), **script** (`IScript` exigido pela tela em `RequiredScripts`) e **recurso** (`IResource` com `DeployAction`/`TargetDirectory`). Um UI Flow próprio recebe o tema, para não mexer no `MainFlow` do WrightFlood | `client-js-reactive.json` (parte do `IScript`); tema e recurso **não têm job no O11** |
| `tests/jobs-odc/client-storage.json` | **Client entity** (local storage: Id Long Integer **sem** AutoNumber, `IdentifierAttribute`) e **client action** com nó de JavaScript, `CreateOrUpdateWfCovDraft` e aggregate de tela `isClientSide` | `local-storage-mobile.json` + `client-js-reactive.json` |
| `tests/jobs-odc/rest-expose.json` | **REST exposto**: `IRestService` + `IRestServiceAction` GET (que já nasce com Start e End), input `ReceiveIn: URL`, output `SendIn: Body` tipado por structure pública, Assign a preencher a resposta | `rest-expose.json` |
| `tests/jobs-odc/structure-list-type.json` | **Structure anónima** (aggregate com group by + `IAggregatedAttribute` Count + coluna calculada devolve linhas de `IAnonymousStructure:WfCovProjectSummary Record`) e **list type** (`IListType:WfCovProjectSummary List`, criado por `GetOrCreateListType` ao tipar o output e a variável) | `aggregate-sum-calc.json` |
| `tests/jobs-odc-negative/session-variable-not-in-odc.json` | **Recusa**: `ISessionVariable` está na API pública do ODC mas o produto não a tem; a fábrica recusa na hora. Corre em `OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane` | (não há: no SS11 session variable é Traditional Web) |

Nenhum job precisa de linha nova no `AGENTS.md`: a regra 4 do plano só cobre `tests/jobs`.
Sugestão (opcional) para o integrador, se quiser que uma sessão fria encontre estes tipos:
na linha "Timer" da tabela 1 do `AGENTS.md`, acrescentar `tests/jobs-odc/timer-action.json`;
nas linhas "Site property", "Client variable", "Role" acrescentar `tests/jobs-odc/security-settings.json`
(e a nota de que no ODC o nome do produto é **Setting**, e que a expressão é `Settings.<Nome>`, não `Site.<Nome>`);
na linha "Client entity (local storage)" e "Client action", `tests/jobs-odc/client-storage.json`;
na linha "REST exposto", `tests/jobs-odc/rest-expose.json`;
na linha "Session variable", que no ODC **não existe** (`tests/jobs-odc-negative/session-variable-not-in-odc.json`).

---

## Provas (comando e saída colados)

Comando, para todos:

```powershell
cd C:\Users\andre\Anvil-cov-c
$env:ANVIL_ODC_PORT='4667'
python scripts\run_job.py tests\jobs-odc\<job>.json --lane odc
```

### timer-action

```
== timer-action.json: ok=True {'ops': 10, 'objects': 59502, 'isValid': True, 'messages': 55, 'applyMs': 693}
   via worker odc | 5797 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get ITimer WfCovOverdueSweep {... "CronSchedule": "15 3 * * *", "Action": "@y6+LU5_GnEW_sDnUf6TEsQ",
      "Description": "Cobertura T: varre tarefas vencidas de madrugada", "IsMultiTenant": "Inherited",
      "Name": "WfCovOverdueSweep", "Priority": "Normal", "Schedule": "03:15", "TimeoutInMinutes": "20",
      "ScheduleConfiguration": "@NHxIl+M0n0OcLlJzl+TwKA.#ScheduleConfiguration",
      "WakeTimerAction": "@NHxIl+M0n0OcLlJzl+TwKA.#WakeTimer"}
     ISchedule
       IMinute
       IHour
       IMonth
       IDayOfMonth
       IDayOfWeek
     IActionSignature WakeWfCovOverdueSweep
   usages {"target": "IServerAction 'WfCovTask_SweepOverdue'", "count": 1, "real": 1, "byType": {"ITimer": 1},
     "entries": [{"type": "ITimer", "name": "WfCovOverdueSweep", ..., "path": "ITimer:WfCovOverdueSweep", "derived": false}]}
```

### security-settings

```
== security-settings.json: ok=True {'ops': 51, 'objects': 59464, 'isValid': True, 'messages': 55, 'applyMs': 684}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get ISiteProperty WfCovMaxRows {... "Descriptor": "ServiceStudio.Model.Variables+SiteProperty+ClassDescriptor",
      "CollectionDescriptor": "SiteProperties", "Referrers": 2, "DataType": "@j2Lc0phK0kuggij4gQYfAw",
      "DefaultValue": "100", "Description": "Cobertura T: Setting (Site Property na API) lida pela logica de auditoria",
      "IsMultiTenant": "Inherited", "Name": "WfCovMaxRows"}
   get ISiteProperty WfCovAuditToken {... "Description": "Cobertura T: Setting secreta", "IsMultiTenant": "Inherited",
      "IsSecret": "True", "Name": "WfCovAuditToken"}
   get IMobileScreen WfCovAuditScreen {... "Name": "WfCovAuditScreen", "Widgets": 16, ... "Roles": 2,
      "LocalVariables": 1, ... "ScreenActions": 1}
   usages {"target": "IUserException 'WfCovNotAllowed'", "count": 2, "real": 2, "byType": {"IRaiseExceptionNode": 2},
     "entries": [{... "path": "IServerAction:WfCovAudit_Check/IRaiseExceptionNode", "derived": false},
                 {... "path": "IServerAction:WfCovAudit_Check/IRaiseExceptionNode", "derived": false}]}
   usages {"target": "IClientVariable 'WfCovLastFilter'", "count": 2, "real": 2, "byType": {"ITextBasedExpression": 2},
     "entries": [{... "text": "\"Last filter: \" + Client.WfCovLastFilter",
                  "path": ".../IContainer:AuditBox/IContent:content/IExpression/CustomProperty:Value/ITextBasedExpression"},
                 {... "text": "Client.WfCovLastFilter",
                  "path": ".../IScreenAction:ApplyFilter/IAssignNode/IAssignment/ITextBasedExpression"}]}
```

### theme-script-resource

```
== theme-script-resource.json: ok=True {'ops': 29, 'objects': 59365, 'isValid': True, 'messages': 55, 'applyMs': 2057}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IMobileTheme WfCovTheme {... "CollectionDescriptor": "MobileThemes", "Referrers": 1,
      "ActualIconLibrary": "Phosphor2.0", "LayoutBlock": "@TKLCLOMOTkq37zLH_v8Zgg", "GridType": "Inherited",
      "Columns": "12", "GutterWidth": "20", "ColumnWidth": "60",
      "StyleSheet": ".wf-cov-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #eef; }",
      "BaseTheme": "@EHWy15q2lEymE4eJ_Th8yQ", ... "Name": "WfCovTheme", "IconLibrary": "Inherited",
      "StyleSheetExpression": "@j8mS9fyFfESrPbl5_kAORg.#StyleSheet.#CssSource"}
   get IScript WfCovFormatting {... "CollectionDescriptor": "Scripts", ... "Name": "WfCovFormatting",
      "RuntimePath": "/WrightFlood/scripts/WrightFlood.WfCovFormatting.js",
      "JavaScript": "window.WfCovFormatting = { badge: function (s) { return String(s || \"\").toUpperCase(); } };"}
   get IResource WfCovAuditTemplate {... "DisplayName": "templates\\WfCovAuditTemplate",
      "CollectionDescriptor": "Resources", ... "DeployAction": "CopyToApplicationDir",
      "RuntimePath": "/WrightFlood/templates/WfCovAuditTemplate", "TargetDirectory": "templates"}
   get IMobileFlow WfCovThemeFlow {... "WebScreens": 1, ... "Nodes": 1, "Theme": "@j8mS9fyFfESrPbl5_kAORg", ...}
   usages {"target": "IScript 'WfCovFormatting'", "count": 1, "real": 1, "byType": {"ScriptDependency": 1},
     "entries": [{"type": "ScriptDependency", ..., "path": "IMobileFlow:WfCovThemeFlow/IMobileScreen:WfCovBadgeScreen/ScriptDependency"}]}
   usages {"target": "IMobileTheme 'WfCovTheme'", "count": 1, "real": 1, "byType": {"IMobileFlow": 1},
     "entries": [{"type": "IMobileFlow", "name": "WfCovThemeFlow", ..., "path": "IMobileFlow:WfCovThemeFlow"}]}
```

### client-storage

```
== client-storage.json: ok=True {'ops': 70, 'objects': 59511, 'isValid': True, 'messages': 55, 'applyMs': 856}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   data contract: 13 checks, accepted=True
   get IClientEntity WfCovDraft {... "Descriptor": "ServiceStudio.Model.Entity+ClientEntityDescriptor",
      "CollectionDescriptor": "Entities", "Referrers": 9, ... "Attributes": 3, "Fields": 3,
      "ExposeCreateAndChangeActions": "True", "Icon": "OutSystems.Model/Images/ClientEntity.ico",
      "Name": "WfCovDraft", ... "IdentifierAttribute": "@O0Mo2zwvPkWNeAcQIrw0nQ", "EntityKind": "Client", ...}
   get IEntityAttribute Id {... "DataType": "@H6G+eTAigEi7LPUbg3Ey0g", "IsMandatory": "True", "Name": "Id",
      "IsAutoNumber": "No", ... "ParentStructure": "@J3L63+rUJUyaZ0X8Nd_k5g", "DeleteRule": "Ignore"}
     IInputParameter Title
     ILocalVariable Draft
     IExecuteClientActionNode StoreDraft
         ITextBasedExpression  = Draft
     IAssignNode
       IAssignment
         ITextBasedExpression  = Draft.Title
         ITextBasedExpression  = NormalizeTitle.Clean
       IAssignment
         ITextBasedExpression  = Draft.SavedOn
         ITextBasedExpression  = CurrDateTime()
     IJavaScriptNode NormalizeTitle
       IInputParameter Raw
       IOutputParameter Clean
         ITextBasedExpression  = Title
   usages {"target": "IClientAction 'WfCovDraft_Save'", "count": 1, "real": 1, "byType": {"IExecuteClientActionNode": 1},
     "entries": [{"type": "IExecuteClientActionNode", "name": "CallSave", ...,
       "path": "IMobileFlow:MainFlow/IMobileScreen:WfCovDraftScreen/IScreenAction:SaveDraft/IExecuteClientActionNode:CallSave"}]}
```

### rest-expose

```
== rest-expose.json: ok=True {'ops': 31, 'objects': 59325, 'isValid': True, 'messages': 55, 'applyMs': 575}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IRestServiceAction WfCovGetZone {... "Descriptor": "ServiceStudio.Plugin.RESTService.RestServiceAction+ClassDescriptor",
      "CollectionDescriptor": "Actions", ... "InputParameters": 1, "OutputParameters": 1, "IsInitialized": "True",
      "Name": "WfCovGetZone", ... "Nodes": 3, "URL": "/WrightFlood/rest/WfCovZoneService/WfCovGetZone/{Postcode}",
      "URLPath": "/WfCovGetZone/{Postcode}", "HTTPMethod": "GET"}
   get IRestServiceActionInput Postcode {... "Type": "Text", "IsMandatory": "True", "Name": "Postcode",
      ... "ReceiveIn": "URL", "IsSensitive": "NotSensitive"}
   get IRestServiceActionOutput Info {... "Name": "Info", ... "SendIn": "Body", "IsSensitive": "NotSensitive"}
     IRestServiceAction WfCovGetZone
       IRestServiceActionInput Postcode
       IRestServiceActionOutput Info
       IEndNode
       IStartNode
       IAssignNode
         IAssignment
           ITextBasedExpression  = Info.Zone
           ITextBasedExpression  = Postcode
         IAssignment
           ITextBasedExpression  = Info.IsHighRisk
           ITextBasedExpression  = Length(Postcode) > 5
```

### structure-list-type

```
== structure-list-type.json: ok=True {'ops': 46, 'objects': 59523, 'isValid': True, 'messages': 55, 'applyMs': 688}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IOutputParameter Summaries {... "DataType": "@eAu2hYPUV0i9nfR+VYW8iQ", "Name": "Summaries"}
   get IAggregatedAttribute OpenCount {... "Descriptor": "ServiceStudio.Model.AggregateAttribute+ClassDescriptor",
      "CollectionDescriptor": "AggregatedAttributes", ... "AggregationType": "Count", "Attribute": "WfCovTask.Id",
      "DataType": "@H6G+eTAigEi7LPUbg3Ey0g", "Name": "OpenCount"}
     IGroupByOperation
       IGroupByAttribute ProjectId
         ITextBasedExpression  = WfCovTask.ProjectId
       IAggregatedAttribute OpenCount
         ITextBasedExpression  = WfCovTask.Id
     ICombineSourcesOperation WfCovTasks
       IAliasedSource WfCovTask
       ICalculatedAttribute ProjectLabel
         ITextBasedExpression  = "Task: " + WfCovTask.Title
       IFilter
         ITextBasedExpression  = WfCovTask.IsDone = False
     IAddSourceOperation WfCovTask
   usages {"target": "IStructure 'WfCovProjectSummary'", "count": 8, "real": 8,
     "byType": {"IAttribute": 1, "IListType": 1, "ITextBasedExpression": 4, "ILocalVariable": 1, "IArgument": 1},
     "entries": [
       {"type": "IAttribute",  "name": "WfCovProjectSummary",
        "path": "IAnonymousStructure:WfCovProjectSummary Record/IAttribute:WfCovProjectSummary", "derived": false},
       {"type": "IListType",   "name": "WfCovProjectSummary List",
        "path": "IListType:WfCovProjectSummary List", "derived": false},
       {"type": "ILocalVariable", "name": "Row", "path": "IServerAction:WfCovProject_Rollup/ILocalVariable:Row"},
       ...]}
```

Os dois tipos aparecem nomeados na mesma saída: `IAnonymousStructure:WfCovProjectSummary Record`
(a linha do aggregate agrupado) e `IListType:WfCovProjectSummary List` (a lista pedida pelo output).

### session-variable-not-in-odc (recusa)

```
python scripts\run_job.py tests\jobs-odc-negative\session-variable-not-in-odc.json --lane odc

  "error": "op #0 (create WfCovSessionState): InvalidOperationException: Session Variable objects can't be
            children of App objects",
```

### Toda a faixa ODC depois da frente T (23 jobs, um a um)

```
block-events                  :: ok=True  isValid=True  messages=55  accepted=True
client-storage                :: ok=True  isValid=True  messages=55  accepted=True   (novo)
data-entity                   :: ok=True  isValid=True  messages=55  accepted=True
data-full-model               :: ok=True  isValid=True  messages=55  accepted=True
delete-attribute-no-consumers :: ok=True  isValid=True  messages=55  accepted=True
delete-data-consumers         :: ok=True  isValid=True  messages=55  accepted=True
delete-logic-consumers        :: ok=True  isValid=True  messages=55  accepted=True
html-visual-alert             :: ok=True  isValid=True  messages=55  accepted=True
html-visual-block             :: ok=True  isValid=True  messages=56  accepted=True
html-visual-list              :: ok=True  isValid=True  messages=55  accepted=True
logic-action                  :: ok=True  isValid=True  messages=56  accepted=True
logic-sql                     :: ok=True  isValid=True  messages=55  accepted=True
logic-steps                   :: ok=True  isValid=True  messages=55  accepted=True
refactor-replace-action       :: ok=True  isValid=True  messages=57  accepted=True
rest-consume                  :: ok=True  isValid=True  messages=55  accepted=True
rest-expose                   :: ok=True  isValid=True  messages=55  accepted=True   (novo)
screen-basic                  :: ok=True  isValid=True  messages=55  accepted=True
screen-form                   :: ok=True  isValid=True  messages=55  accepted=True
screen-list                   :: ok=True  isValid=True  messages=55  accepted=True
security-settings             :: ok=True  isValid=True  messages=55  accepted=True   (novo)
structure-list-type           :: ok=True  isValid=True  messages=55  accepted=True   (novo)
theme-script-resource         :: ok=True  isValid=True  messages=55  accepted=True   (novo)
timer-action                  :: ok=True  isValid=True  messages=55  accepted=True   (novo)
```

(55 é o número de mensagens pré-existentes da fixture; nenhum job novo acrescentou nenhuma.)

### Suíte da faixa ODC (o gate de regressão)

```powershell
cd C:\Users\andre\Anvil-cov-c
$env:ANVIL_ODC_PORT='4667'
dotnet test tests\Anvil.Tests.Odc -c Release --nologo
```

```
Execução de teste para C:\Users\andre\Anvil-cov-c\tests\Anvil.Tests.Odc\bin\Release\net8.0\Anvil.Tests.Odc.dll (.NETCoreApp,Version=v8.0)
1 arquivos de teste no total corresponderam ao padrão especificado.

Aprovado!  – Com falha:     0, Aprovado:    33, Ignorado:     0, Total:    33, Duração: 2 m 23 s - Anvil.Tests.Odc.dll (net8.0)
```

33 testes: os 23 jobs de `tests/jobs-odc` (`JobAppliesAndVerifies`), os 3 de recusa de
`tests/jobs-odc-negative` (`JobFailsWithTheTeachingMessageInTheOdcLane`) e os testes do adaptador.
Os dois runners varrem as pastas sozinhos (`Jobs()` e `NegativeJobs()` em `OdcJobTests.cs`): não foi
preciso editar nenhum arquivo de teste para os jobs novos entrarem.

---

## Diferenças de plataforma encontradas

Conferidas antes contra `C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md`: **nenhuma destas
está lá**. Onde a diferença podia ser falsa, a comparação foi feita contra o catálogo do SS11
(`catalog/model-api-11.55.69.json`, `OutSystems.Model.V1` 12.0.0.0 da instalação SS4) e está escrita abaixo.

### 1. Site Property chama-se **Setting** no produto ODC (e o vocabulário aparece no Verify)

A API pública **manteve o nome antigo** nas duas faixas: `OutSystems.Model.Data.ISiteProperty`,
`IESpace.CreateSiteProperty(bool isReadOnly = false, string name = null, IKey key = null)`,
`[ModelInterface(DisplayName = "Site Property")]`, e o conjunto de propriedades é **idêntico** ao do SS11
(`DataType`, `DefaultValue`, `Description`, `Folder`, `IsMultiTenant`, `IsReadOnly` (só leitura), `IsSecret`, `Name`).
Quem renomeou foi o produto. Prova, do Verify do ODC Studio instalado (mensagem NOVA, vista ao correr
uma versão anterior do `security-settings.json` em que as Settings não eram usadas):

```
Warning UnusedElement: Unused Element | Setting 'WfCovAuditToken' is never used in App 'WrightFlood'.
  Consider deleting it. @ WrightFlood (ESpace) / WfCovAuditToken (SiteProperty)
```

Repare no par completo: o **texto** diz `Setting` e `App`, o **caminho** (que vem do modelo) diz `SiteProperty`
e `ESpace`. Marcas de modelo, em `OutSystems.Model.V1/OutSystems.Model.ModelFeatures/ModelFeatures.cs`:

```
public const string SitePropertiesRefactoredToSettings = "ModelFeature_SitePropertiesRefactoredToSettings";
public const string SitePropertiesSupportsSecrets      = "ModelFeature_SitePropertiesSupportsSecrets";
public const string SitePropertiesSupportsSecretsO11   = "ModelFeature_SitePropertiesSupportsSecretsO11";
```

**O job usa o nome do produto**: `tests/jobs-odc/security-settings.json` chama-se e descreve-se por Setting,
embora crie `ISiteProperty`, que é o que a API oferece.

### 2. O prefixo de expressão mudou: `Settings.<Nome>` no ODC, `Site.<Nome>` no SS11

Esta é a metade prática da diferença anterior, e é a que faz uma LLM perder tempo. Em
`ServiceStudio.Model/ModelFrameworkConstants.cs` (assembly `OutSystems.Model` do ODC Studio):

```csharp
public static class ScopeTreeFolders
{
    public const string SiteProperties = "Site";
    public const string Settings       = "Settings";
    ...
    public static string GetSiteOrSettings(ESpace eSpace)
    {
        if (!ModelFeatures.SitePropertiesRefactoredToSettings.CanBeUsedInServerAndServiceStudio(eSpace))
            return "Site";
        return "Settings";
    }
}
```

Provado ao vivo nas duas direções. Sem prefixo nenhum (a forma que eu tentei primeiro):

```
Error ExpressionUnknownObject: Invalid Expression | Can't identify 'WfCovMaxRows' element in expression.
  @ WrightFlood (ESpace) / WfCovAudit_Check (ServerAction) / Rows > WfCovMaxRows (IfNode)
```

Com o prefixo do SS11 (`Site.`), sonda `.local/probes-t/probe-site-prefix.json`:

```
== probe-site-prefix.json: ok=False {'ops': 17, 'objects': 59293, 'isValid': False, 'messages': 57}
Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Site' element in expression.
  @ WrightFlood (ESpace) / WfProbe_ReadSite (ServerAction) / ReadWithSitePrefix (AssignNode) / Assignment
```

Com `Settings.WfCovMaxRows`: 0 mensagens novas (o job `security-settings.json` acima).
A variável de cliente segue a mesma tabela e é `Client.<Nome>` (`ScopeTreeFolders.Client = "Client"`),
também provado no mesmo job, lida numa expressão e gravada num Assign.

### 3. "Public" chama-se **Shareable**, e usar tipo não partilhável é **erro**

Duas evidências. Na API do ODC, `IServerAction` (e `ITheme`, `IScript`, `IResource`, `IImage`, `IStructure`)
tem **as duas** propriedades:

```csharp
// ODC: OutSystems.Model.V1/OutSystems.Model.Logic/IServerAction.cs
public interface IServerAction : ..., IShareableESpaceObject<IServerAction, IServerActionSignature>, IShareable
    [Property(DisplayName = "Public")]    bool Public    { get; set; }
    [Property(DisplayName = "Shareable")] bool Shareable { get; set; }
```

No SS11 o mesmo `OutSystems.Model.Logic.IServerAction` só tem `Public:Boolean` (catálogo do SS4).
No catálogo do Verify do ODC (`anvil-odc verify-catalog`), o **id** ainda diz Public e o **texto** diz shareable,
com severidade Error:

```json
{ "Id": "InvalidPublic_ActionParameterNotPublic", "Severity": "Error", "Title": "Invalid Shareable Action",
  "Detail": "The Action '{0}' is shareable but its parameter '{1}' is defined as a record of type {2} that is not shareable." }
{ "Id": "InvalidPublicNRBlock", "Severity": "Error", "Title": "Invalid Shareable Block",
  "Detail": "Block '{0}' cannot be shareable. It cannot navigate to Screens using Destination elements or use other blocks that do so." }
```

Os jobs continuam a escrever `set Public true`, que é o que funciona nas duas faixas; o vocabulário Shareable
está nas descrições e nos `_why`.

### 4. `IAggregateAttribute` (SS11) chama-se `IAggregatedAttribute` (ODC)

Erro colado, ao espelhar `aggregate-sum-calc.json` letra a letra:

```
"error": "op #12 (create OpenCount): KeyNotFoundException: unknown Model API type: IAggregateAttribute
          (not in OutSystems.Model.V1 nor in the Studio plugins)"
```

Comparação: o catálogo do SS11 tem `OutSystems.Model.Logic.Aggregates.IAggregateAttribute`; a API do ODC
tem `OutSystems.Model.Logic.Aggregates.IAggregatedAttribute`, com o **mesmo** `DisplayName = "Aggregate Attribute"`
e as mesmas propriedades (`AggregationType`, `Attribute`, `DataType`, `Name`). A classe concreta por trás continua a
chamar-se `ServiceStudio.Model.AggregateAttribute` nas duas (o `get` do job mostra-o), e a coleção do pai é
`AggregatedAttributes`. Ou seja: **só o nome da interface mudou**, e é o nome que o job escreve.

### 5. O Timer do ODC tem agendamento estruturado; o do SS11 é só uma string

O SS11 tem `Schedule:String`. O ODC tem `Schedule`, mais `CronSchedule:String` e o filho
`ScheduleConfiguration` (`OutSystems.Model.Processes.ISchedule`, com `ScheduleItems`, `WhenPublished`,
`ToCronExpression()`, `FromCronExpression()`, `CreateHour/CreateMinute/CreateMonth/CreateDayOfWeek/CreateDayOfMonth/CreateWeekOfMonth/CreateTimeOfDay`).
Escrever `CronSchedule` preenche os dois lados: o `get` do `timer-action.json` mostra
`"CronSchedule": "15 3 * * *"` **e** `"Schedule": "03:15"`, e o `dump` mostra o `ISchedule` com os cinco itens.

O cron é de **cinco** campos (`minuto hora diaDoMês mês diaDaSemana`), não seis. Com a forma Quartz:

```
"error": "op #4 (set CronSchedule): InvalidOperationException: Invalid cron expression provided: 0 15 3 * * ?"
   at ServiceStudio.Model.Schedule.FromCronExpression(String cronExpression)
```

Confirmado na fonte (`ServiceStudio.Model/Schedule.cs`):
`ToCronExpression<Minute>() + " " + ToCronExpression<Hour>() + " " + ToCronExpression<DayOfMonth>() + " " + ToCronExpression<Month>() + " " + ToCronExpression<DayOfWeek>()`.

### 6. `ListAppend` é ambíguo no ODC: existe como client E como server action

`{"op":"find","name":"ListAppend"}` sobre a fixture:

```
find [('IClientActionSignature', 'ListAppend'), ('IServerActionSignature', 'ListAppend'),
      ('IExecuteClientActionNode', 'ListAppend'), ...]
```

A forma do job do SS11 (`"value": "IActionSignature:ListAppend"`, de `data-action-reactive.json`) acerta na
**do cliente** e o nó de servidor recusa-a:

```
"error": "op #30 (set Action): InvalidOperationException: Cannot set
          OutSystems.Model.Logic.Nodes.IExecuteServerActionNode.Action to 'ListAppend' (OutSystems.Model.IObject):
          the value is not valid in this context"
```

Correção no job: `"value": "IServerActionSignature:ListAppend"`. Não é bug do kernel — `IActionSignature:` é um
pedido ambíguo e a fixture do ODC tem as duas; mas quem copia o job do O11 bate nisto.

### 7. `ISessionVariable`: a API tem, o produto não (o mesmo padrão do `CreateBusinessProcess`)

`IESpace.CreateSessionVariable(bool isReadOnly = false, string name = null, IKey key = null)` está na API pública
do ODC tal como no SS11, e `OutSystems.Model.Data.ISessionVariable` existe com as mesmas propriedades. A fábrica
recusa:

```
"error": "op #0 (create WfCovSessionState): InvalidOperationException: Session Variable objects can't be
          children of App objects"
```

Fixado em `tests/jobs-odc-negative/session-variable-not-in-odc.json`. Repare de novo no vocabulário: **App**.

### 8. `DeployAction` do recurso: **não** é diferença (confirmado, para ninguém repetir)

A minha primeira tentativa foi `DeployToTargetDirectory` e o kernel recusou:

```
"error": "InvalidOperationException: op #2: $r.DeployAction value 'DeployToTargetDirectory' invalid;
          allowed: Ignore, CopyToApplicationDir; see anvil api --name DeployAction"
```

Parece diferença, **não é**: as duas faixas têm dois enums `DeployAction` distintos, iguais entre si.
`OutSystems.Model.Enumerations.DeployAction` (o de `IResource`) = `Ignore, CopyToApplicationDir` nas duas;
`OutSystems.Model.Extensions.DeployAction` (o de módulos de extensão) =
`Ignore, CopyToBinariesDirectory, CopyToApplicationDirectory, CopyToImagesDirectory` nas duas.
Só o `DisplayName` do valor engana: `CopyToApplicationDir` mostra-se como "Deploy to Target Directory".

### 9. `WriteableSiteProperties`: a mensagem existe, mas **não disparou** headless — a registar, não a afirmar

O pedido do dono era investigar se, além do nome, o comportamento mudou. O que encontrei:

- `ModelFeatures.cs` do ODC tem `WriteableSiteProperties = "ModelFeature_WriteableSiteProperties"`
  (DisplayName "Site Property Is Writeable", `predatesContinuousDelivery: true`).
- O catálogo do Verify do ODC Studio instalado tem **duas** mensagens de remoção, ambas Error, e a mais recente
  já usa a palavra *setting*:

```json
{ "Id": "ModelFeature_RemovedFeature_ModelFeature_WriteableSiteProperties", "Severity": "Error", "Title": "Invalid app",
  "Detail": "You cannot change the value of a setting within an action. To change settings values, you must edit their default values." }
{ "Id": "ModelFeature_WriteableSiteProperties_Removed", "Severity": "Error", "Title": "Invalid Module",
  "Detail": "Cannot change the value of a {0} within an action. To change {0} values, you must edit their default values." }
```

- `ServiceStudio.Verify/ModelFeaturesVerifyMessagesManager.cs` liga a mensagem à marca:
  `FeatureMapper.Add(VerifyMessageId.Parse("ModelFeature_WriteableSiteProperties_Removed"), "ModelFeature_WriteableSiteProperties");`
- `ServiceStudio.Expressions/ParsedExpression.cs:1441` regista o **uso** da marca ao gravar:
  `addUsage(ServiceStudio.ModelFeatures.ModelFeatures.WriteableSiteProperties, null);`

**Mas**: a sonda `.local/probes-t/probe-setting-write.json`, que grava `Settings.WfProbeLimit` num `IAssignNode`
dentro de uma server action, passou limpa:

```
== probe-setting-write.json: ok=True {'ops': 17, 'objects': 59293, 'isValid': True, 'messages': 55, 'applyMs': 17}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, ...} accepted= True
```

Leitura honesta: estas mensagens são **gatilhadas pelo estado da marca no ambiente** (as marcas nascem
`ModelFeatureStatus.Undefined` com `checkEnvironmentCompatibility: true`, e o `FeatureMapper` só as emite quando
o ambiente diz que a funcionalidade não está disponível). A nossa corrida é headless, sem ambiente, com o cache
local `Features.xml` — por isso não disparou. **Não está provado** que gravar uma Setting é erro no ODC; está
provado que a plataforma tem a mensagem, o texto dela e o mecanismo. Confirmar isto exige o Studio ligado ao
tenant, que esta frente não usa. Por precaução, o `security-settings.json` só **lê** as Settings.

### 10. Complemento (não contradição) ao `UserStyleSheet` do WS4/T7

O `2026-09-17-ws1-diferencas.md` diz que o compilador de HTML visual instala o CSS de autor e o ODC o guarda em
`UserStyleSheet`, não em `StyleSheet`. Confirmo que são dois lugares diferentes: quando se escreve pela API
pública, `ITheme.StyleSheet` (a única das duas que a API expõe; `UserStyleSheet` é da classe concreta
`ServiceStudio.Model.NewRuntime.Theme`), o CSS fica **em `StyleSheet`** — `get IMobileTheme WfCovTheme` mostra
`"StyleSheet": ".wf-cov-badge { ... }"`. Não há conflito com a nota antiga: o caminho é que é outro.

---

## Tipos que NÃO existem no ODC (e onde procurei)

| Tipo pedido | Situação no ODC | Onde procurei / erro colado |
|---|---|---|
| **Session variable** | **Não existe.** A API tem `ISessionVariable` e `IESpace.CreateSessionVariable`, o produto não | `OutSystems.Model.V1/OutSystems.Model.Data/ISessionVariable.cs` e `IESpace.cs`; recusa viva: `InvalidOperationException: Session Variable objects can't be children of App objects`. Fixado em `tests/jobs-odc-negative/session-variable-not-in-odc.json` |
| **Local storage como tipo próprio** | Não existe com esse nome: é `IClientEntity`, o mesmo nome do SS11 | `KeyNotFoundException: unknown Model API type: ILocalStorageEntity (not in OutSystems.Model.V1 nor in the Studio plugins)`; `IClientEntity` criado com sucesso em `client-storage.json` |
| **`ISystemRole`** | Existe na API, não se cria a partir do módulo | `IESpace 'WrightFlood' cannot create ISystemRole (no Create method in the API)`. O role de autor é `IRole` → concreto `IAppRole` (`IESpace.CreateRole`), provado em `security-settings.json` |
| **`IService` / `IExposedAction`** (os nomes de `OutSystems.Model.Logic.Integrations`) | Abstratos (`IsConcrete = false`), sem classe concreta própria | `ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService` e `IESpace 'WrightFlood' cannot create IExposedAction (no Create method in the API)`. O REST exposto de verdade é `IRestService` (plugin `ServiceStudio.Plugin.RESTService`, criado por `IESpace.CreateIntegration<T>`), provado em `rest-expose.json` |
| **Processo (BPT)** | Confirmado o que a segunda onda do plano já diz: a API tem `IESpace.CreateBusinessProcess`, o produto não tem a funcionalidade | `OutSystems.Model.V1/OutSystems.Model/IESpace.cs`. Não escrevi job |

Nota: **`IRestService` existe mesmo no ODC**, ao contrário do que a tabela da primeira onda supunha
(`rest-consume.json` só cobria o lado consumido). O ODC tem ainda `ISOAPService` (`IESpace.CreateSOAPService`),
que nenhuma das duas faixas cobre.

---

## Bloqueios

**Imagem de módulo (`IImage`) não é exprimível pela linguagem de jobs — nas DUAS faixas.**

```
"error": "op #0 (create WfProbeImage): InvalidOperationException: Image binary cannot be null: Object not set"
```

Porquê: o único construtor é `IImage CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null)`
(e a sobrecarga com `ImageFormat/width/height`). O `create` do kernel mapeia `args` para os parâmetros pelo nome
(`Verbs.cs`, `FindCreateCore`/`Create`), mas o `Convert` só sabe converter `JsonValue` para `string`, `bool`,
`int`, `long`, `decimal`, enum, `ITypeSignature`, interface do modelo e `ExpressionDefinition` — **não para
`byte[]`**. Não há como passar o binário num job.

Não é diferença de plataforma: o catálogo do SS11 tem exatamente a mesma assinatura
(`{"Name":"CreateImage","Returns":"OutSystems.Model.UI.IImage","Parameters":["Byte[] binary","String originalPath","String name?","OutSystems.Model.IKey key?"]}`),
e por isso **nenhuma das duas faixas** tem job de imagem de módulo hoje. O `IImage` que aparece em
`tests/jobs/gallery-native-reactive.json` é outro tipo: o **widget** `ServiceStudio.Plugin.NRWidgets.IImage`
dentro de uma tela, não o recurso do módulo.

Resolver isto exige tocar em `Verbs.cs` (fazer o `Convert` aceitar, por exemplo, `{"binary": {"file": "..."}}` ou
base64, com o mesmo cuidado da regra "nenhum binário em repositório"). Pela regra 3 do plano, **não mexi**.
Fica registado como bloqueio para o integrador; o recurso (`IResource`), cujo `byte[] binary` é opcional na
prática (o kernel passa `null` e o Verify aceita), ficou coberto em `theme-script-resource.json`.

Curiosidade útil para quem for resolver: o ODC tem a marca `ModelFeature_ImageWithoutBinary`, ligada à mensagem
de Verify `ImageWithoutBinary` (`ModelFeaturesVerifyMessagesManager.cs`), o que sugere que lá uma imagem sem
binário é representável.

Nenhum outro bloqueio. A porta 4667 estava livre ao começar; não foi preciso escrever `BLOCKER.md`.

---

## Fora do brief

1. **Parei um worker ODC órfão da porta 4567** (PID 55536, `anvil-odc.dll serve --port 4567`), deste mesmo
   worktree, sobra de uma sessão anterior: ele segurava `.local/lane-odc/cli/Anvil.Core.Odc.dll` e fazia o
   `build_odc.py` falhar com `MSB3027 ... O arquivo é bloqueado por: ".NET Host (55536)"`. Parei-o pelo caminho
   limpo (`odc_worker.stop(4567)`), não com `kill`. Nenhuma porta de outra frente (4517/4547/4617/4647/4627/4657)
   foi tocada.
2. **Job de recusa** (`session-variable-not-in-odc.json`), que o brief não pedia: o brief mandava registar no
   relatório o que o ODC não tem, e a pasta `tests/jobs-odc-negative` com runner próprio já existia. Um job fixa
   a mensagem de recusa como regressão; a linha do relatório sozinha não.
3. **Sondas** em `.local/probes-t/` (não versionadas, `.local/` está no `.gitignore`): `probe-<Tipo>.json` para
   descobrir que tipos o `@espace` do ODC cria, `probe-site-prefix.json`, `probe-setting-write.json`,
   `probe-resource.json`, `probe-listappend.json`. São a origem dos erros colados acima.
4. Li a API pública decompilada em `C:\Users\andre\ODC3\decompiled\odc\` (só leitura; nada copiado para o
   repositório).

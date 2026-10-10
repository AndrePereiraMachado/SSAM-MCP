# Frente C — paridade da faixa ODC em dados, lógica e interface

**Frente C — estado: concluída**

**Branch/worktree:** `cov/c` em `C:\Users\andre\Anvil-cov-c`; commits `be3e084`, `96fa71c`.
**Faixa:** só ODC. Nenhum job da faixa O11 foi executado e `ANVIL_LANE` nunca foi definida.
Porta do worker ODC: `4567` (`$env:ANVIL_ODC_PORT='4567'` em todas as sessões). A porta estava livre no início
(`Get-NetTCPConnection -LocalPort 4567` não devolveu nada antes do `build_odc.py`; depois, `4567 Listen 55536`, o
próprio worker). Base de todos os jobs: a fixture `tests/fixtures/odc/wrightflood-personal-r8.oml`, headless, sem ODC
Studio aberto. Tenant tocado: nenhum — tudo é arquivo.

A faixa ODC passa de **6 para 12 jobs**.

## Jobs entregues

| Job novo (ODC) | Espelha (O11) | O que prova |
|---|---|---|
| `tests/jobs-odc/data-full-model.json` | `hire-data-model.json` (reduzido) | uma op `spec`: static entity com atributo além de Id/Label/Order e records que o preenchem por expressão, três entidades relacionadas por FK (duas públicas), `deleteRule` Protect/Delete, defaults por expressão (`CurrDateTime()`, `Entities.WfCovPriority.Normal`, `False`), `Long Text`, structure pública e três índices (dois únicos, um composto comum) |
| `tests/jobs-odc/logic-steps.json` | `logic-spec-services.json` | uma action pública com TODAS as formas de passo (`get` com `where` e `sort`, `if` com `raise` de exceção do módulo, `foreach` com `assign`, `save` e `call`, `assign` final) e a helper que ela chama declarada DEPOIS de quem a chama, provando a ordenação por dependência do compilador na faixa ODC |
| `tests/jobs-odc/logic-sql.json` | `logic-sql-params.json` | `ISQLNode` pela spec de lógica: statement com dois parâmetros (`@ProjectId`, `@DueUntil`) declarados em `params` e alimentados pelos inputs da action, `max` → MaxRecords, saída tipada pela entidade e atribuída ao output `WfCovTask List` |
| `tests/jobs-odc/screen-form.json` | `screen-form-reactive.json` | server action wrapper que chama a entity action `CreateOrUpdateWfCovTask`, tela Reactive com input parameter, aggregate filtrado pelo input, `IForm` com `IInput`/`ICheckbox` ligados ao registro do aggregate e botão ligado a uma screen action que chama o wrapper |
| `tests/jobs-odc/screen-list.json` | `screen-list-reactive.json` | aggregate ordenado (`ISort`), `IList` + `IListItem` com a swipe action de exemplo apagada, expressões por item, `OnClick` do item navegando para `WfCovTaskDetail(TaskId)` e botão New no placeholder `Actions` com `NullIdentifier()` |
| `tests/jobs-odc/rest-consume.json` | `rest-consume-get.json` | **a API do ODC tem o equivalente**: `IRestClient` com `BaseURL`, `IRestStructure`/`IRestStructureAttribute` com `NameInJSON`, `IRestAction` com `URLPath` parametrizado, input em `UrlPlacement` e output em `BodyPlacement` |

Todos os nomes criados usam o prefixo `WfCov` para não colidir com o `WfProof` dos jobs do WS1 nem com os
elementos do WrightFlood.

## Provas

Comando (idêntico para os seis, só muda o nome do job):

```powershell
cd C:\Users\andre\Anvil-cov-c
$env:ANVIL_ODC_PORT = '4567'
python scripts\run_job.py tests\jobs-odc\<job>.json --lane odc
```

Saída (as 55 mensagens `preexisting` são do próprio WrightFlood, não deste trabalho; ver a última seção):

```
$ python scripts\run_job.py tests\jobs-odc\data-full-model.json --lane odc
   data contract: 137 checks, accepted=True; dataSummary saved in result
== data-full-model.json: ok=True {'ops': 4, 'objects': 59463, 'isValid': True, 'messages': 55, 'applyMs': 684}
   via worker odc | 3078 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

$ python scripts\run_job.py tests\jobs-odc\logic-steps.json --lane odc
   data contract: 0 checks, accepted=True; dataSummary saved in result
== logic-steps.json: ok=True {'ops': 4, 'objects': 59587, 'isValid': True, 'messages': 55, 'applyMs': 759}
   via worker odc | 5625 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   logic declarations {'actions': 2, 'publicActions': 1, 'helpers': 1}

$ python scripts\run_job.py tests\jobs-odc\logic-sql.json --lane odc
   data contract: 0 checks, accepted=True; dataSummary saved in result
== logic-sql.json: ok=True {'ops': 3, 'objects': 59496, 'isValid': True, 'messages': 55, 'applyMs': 549}
   via worker odc | 5530 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   logic declarations {'actions': 1, 'publicActions': 1, 'helpers': 0}

$ python scripts\run_job.py tests\jobs-odc\screen-form.json --lane odc
   data contract: 0 checks, accepted=True; dataSummary saved in result
== screen-form.json: ok=True {'ops': 53, 'objects': 59654, 'isValid': True, 'messages': 55, 'applyMs': 717}
   via worker odc | 6750 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

$ python scripts\run_job.py tests\jobs-odc\screen-list.json --lane odc
   data contract: 0 checks, accepted=True; dataSummary saved in result
== screen-list.json: ok=True {'ops': 25, 'objects': 59821, 'isValid': True, 'messages': 55, 'applyMs': 728}
   via worker odc | 9390 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

$ python scripts\run_job.py tests\jobs-odc\rest-consume.json --lane odc
   data contract: 6 checks, accepted=True; dataSummary saved in result
== rest-consume.json: ok=True {'ops': 25, 'objects': 59338, 'isValid': True, 'messages': 55, 'applyMs': 1359}
   via worker odc | 5032 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

Nenhum job precisou de `expectedMessages`: os seis têm `"expectedMessages": []` e zero mensagens novas.

### Provas pontuais dentro dos jobs

`data-full-model` — o `Long Text` virou Text 2000000 e o índice único composto existe com a ordem declarada:

```
   get IEntityAttribute Notes {... "Length": "2000000", "Name": "Notes", ... "DeleteRule": "Protect"}
   get EntityIndex UQ_WfCovProject_OrgName {"Unique": true, "Entity": "WfCovProject", "Attributes": ["OrganizationId", "Name"]}
   find [('IServerEntity', 'WfCovTask'), ('IAttribute', 'WfCovTask')]
```

`logic-steps` — a helper declarada depois de quem a chama recebeu o consumidor criado dentro do ForEach:

```
   usages {"target": "IServerAction 'WfCov_Task_Describe'", "count": 1, "real": 1,
           "byType": {"IExecuteServerActionNode": 1},
           "entries": [{"type": "IExecuteServerActionNode", "name": "Describe", "key": "BpTCxSsIp0mbA4ccAr6lmw",
                        "path": "IServerAction:WfCov_Project_CloseOpenTasks/IExecuteServerActionNode:Describe",
                        "derived": false}]}
```

`logic-sql` — o `ISQLNode` nasceu com os dois `ISQLInputParameter`, o `ISQLOutput` chamado `List` e o MaxRecords:

```
   IServerAction WfCov_Tasks_SearchSql
     IInputParameter ProjectId
     IInputParameter DueUntil
     IOutputParameter Tasks
     IStartNode
     ISQLNode ReadTasks
       ISQLInputParameter ProjectId
       ISQLInputParameter DueUntil
       ISQLOutput List
         ITextBasedExpression  = DueUntil
         ITextBasedExpression  = ProjectId
       ITextBasedExpression  = 50
     IAssignNode
       IAssignment
         ITypeConversionExpression  = ReadTasks.List mapTo { Value: List }
     IEndNode
```

`screen-form` — o Input herdou `MaxLength` do comprimento do atributo (150) e o botão ficou ligado à screen action:

```
   get IInput Title_Input {... "Variable": "GetTaskById.List.Current.WfCovTask.Title", "Prompt": "\"Title\"",
     "InputType": "Text", "MaxLength": "150", "Mandatory": "True", ...}
   get IBuiltinEvent OnClick {... "Destination": "@ay0cfYHEBU+dIW1WLGimvA", "BuiltInValidations": "ValidateAndContinue", ...}
```

`screen-list` — a swipe action de exemplo saiu (o `rightActions` ficou vazio) e o item navega com argumento:

```
         IList TaskList
           ITextBasedExpression  = GetTasks.List
           IContent content
             IListItem TaskItem
               IContent leftActions
               IContent content
                 IExpression
                 IExpression
               IContent rightActions
               IBuiltinEvent OnClick
   get IBuiltinEvent OnClick {... "Destination": "@FB19pyWDRU6gCIXNic+IHg", "Arguments": 1, ...}
```

`rest-consume` — o cliente REST do ODC aceitou o mesmo desenho do job do O11:

```
   get IRestAction WfCovGetAddressByCep {... "InputParameters": 1, "OutputParameters": 1,
     "URLPath": "/ws/{CEP}/json/", "HTTPMethod": "GET", "RequestFormat": "None", "ResponseFormat": "JSON"}
   get IRestActionOutput Response {... "Name": "Response", "OutputPlacement": "BodyPlacement", "IsSensitive": "NotSensitive"}
```

### Suíte da faixa ODC (descobre os jobs sozinha, por pasta)

`OdcJobTests.Jobs()` varre `tests/jobs-odc/*.json`, portanto os seis jobs novos já são testes:

```powershell
$env:ANVIL_ODC_PORT = '4567'
dotnet test tests\Anvil.Tests.Odc -c Release --nologo
```

```
Aprovado!  - Com falha:     0, Aprovado:    20, Ignorado:     0, Total:    20, Duração: 1 m 44 s - Anvil.Tests.Odc.dll (net8.0)
```

## Linha para o AGENTS.md (o integrador acrescenta)

**Nenhuma.** Toda a entrega está em `tests/jobs-odc`, e a regra 4 do plano dispensa esses jobs da citação
(`GuideTests` não os exige). Se, ainda assim, quiser mencionar a faixa, a seção 3.5 já fala dela; a frase
"jobs de `tests/jobs-odc` (`data-entity`, `logic-action`, `screen-basic`, `html-visual-{alert,list,block}`)"
ficou incompleta e poderia passar a "(`data-entity`, `data-full-model`, `logic-action`, `logic-steps`, `logic-sql`,
`screen-basic`, `screen-form`, `screen-list`, `rest-consume`, `refactor-replace-action`, `html-visual-{alert,list,block}`)".
Isso é sugestão, não exigência: nenhum teste fica vermelho sem ela.

## Diferenças de plataforma encontradas

Antes de cada item conferi `C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md`. As duas abaixo não estão lá.

### 1. No ODC, "public" chama-se **shareable** e a regra é um **erro**, não um aviso: uma action partilhável não pode expor um tipo não partilhável

Apareceu ao espelhar `logic-sql-params.json`, que declara a action `public` e a entidade `SqlItem` `public`.
Na primeira tentativa a minha entidade `WfCovTask` não era pública:

```
== logic-sql.json: ok=False {'ops': 3, 'objects': 59496, 'isValid': False, 'messages': 56, 'applyMs': 707}
   validation {'new': 1, 'fixed': 0, 'preexisting': 55, 'unexpected': 1, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= False
    Error InvalidPublic_ActionParameterNotPublic: Invalid Shareable Action | The Action 'WfCov_Tasks_SearchSql' is
    shareable but its parameter 'Tasks' is defined as a record of type 'WfCovTask' Entity that is not shareable.
    @ WrightFlood (ESpace) / WfCov_Tasks_SearchSql (ServerAction)
    Unexpected InvalidPublic_ActionParameterNotPublic @ WrightFlood (ESpace) / WfCov_Tasks_SearchSql (ServerAction):
    corrija ou declare em expectedMessages com why.
    expectValid=True, but Verify isValid=False
```

O que fiz: pus `"public": true` na entidade `WfCovTask` do `data-full-model.json`, que é exatamente o que o job
original do O11 faz com `SqlItem` — ou seja, a espelhagem fiel já resolve. Vale registrar porque (a) o ID
`InvalidPublic_*` fala "Public" mas o **texto** fala "shareable", então quem procurar pela palavra do menu do ODC não
acha; e (b) no ODC isto é **Error**, o que derruba `isValid` e o job inteiro, em vez de ficar num aviso declarável.
Regra prática ao espelhar jobs O11 para o ODC: toda entidade/structure que aparece na assinatura de uma action
pública tem de ser pública também, e isso precisa vir na mesma `spec` de dados.

### 2. O aviso de segurança "server action pública chamada por tela" tem **ID próprio** no ODC, e por isso a tolerância do kernel nunca o alcança

O `AGENTS.md` (seção 0, ponto 3) e o kernel toleram um aviso específico sem exigir declaração:

```csharp
// src/Anvil.Core/Kernel/MessageExpectations.cs:72
private static bool IsAnonymousAccessWarning(MessageInfo message) => message.Type == "Warning" &&
    message.Id == "CustomObjectWarning" &&
    message.Detail.Contains("You're exposing a Server Action for public access and without authentication.", StringComparison.Ordinal) &&
    message.Detail.Contains("Consider removing the Anonymous Role from this Screen.", StringComparison.Ordinal);
```

No ODC esse mesmo aviso **não** é um `CustomObjectWarning`: é um ID de primeira classe, com texto diferente na
segunda frase. Colado do catálogo Verify da instalação do ODC Studio
(`anvil-odc verify-catalog --id <id>`, porta 4567):

```json
{"Id": "ServerActionInScreenAccessibleByEveryone", "Severity": "Warning", "Title": "Security Warning",
 "Detail": "You're exposing a Server Action for public access and without authentication. Consider restricting Screen accessibility to Authenticated Users."}
```

```json
{"Id": "CustomObjectWarning", "Severity": "Warning", "Title": "{0}", "Detail": "{1}"}
```

Isto é, no ODC `CustomObjectWarning` é só o gabarito genérico `{0}/{1}`; o aviso de segurança tem identidade
própria. Como o predicado exige `Id == "CustomObjectWarning"` **e** a frase "Consider removing the Anonymous Role
from this Screen.", nenhuma das duas condições vale na faixa ODC: o campo `tolerated` sai sempre em `0` (confira nas
saídas acima) e qualquer aviso **novo** desse tipo obriga o job a declará-lo em `expectedMessages` com `why`.

Não me atrapalhou — as 21 ocorrências desse aviso na fixture são preexistentes (são do WrightFlood, não minhas) e o
meu `screen-form.json` chama um wrapper **não público**, que não o dispara. Mas quem escrever um job ODC com uma
tela chamando uma server action pública vai bater nisto. **Não toquei no kernel** (regra 3): fica aqui como decisão
do integrador — ou estender `IsAnonymousAccessWarning` com o ID/texto do ODC, ou manter a exigência de declarar.

### O que NÃO é diferença (conferido antes de afirmar)

- `ICombineSourcesOperation`/`IAddSourceOperation` no `dump` do aggregate do ODC: existem igualmente no O11
  (`docs/mapa/criar-reactive-ui.md`, `docs/mapa/README.md`), então é o mesmo modelo, não uma diferença.
- `IsSensitive` no output REST: está no catálogo do O11 também
  (`catalog/model-api-11.55.69.json`, `ServiceStudio.Plugin.REST.Enumerations.IsSensitive`).
- `UnusedElement` numa structure declarada e ainda sem consumidor: comportamento igual ao do O11; marquei a
  structure `public` (a mesma receita do guia: "ligue ou marque Public") em vez de declarar o aviso.
- `UnusedUserAction` para server action sem consumidor (já registrado no WS1): continua valendo, e `"public": true`
  na action o evita — foi assim que `logic-steps` e `logic-sql` ficaram com `expectedMessages` vazio.
- `Count` de aggregate como `Long Integer` no ODC (já registrado no WS1): usado em `logic-steps`
  (`Summary.OpenTasks` é `Long Integer` e recebe `GetOpenOfProject.Count`).

### As 55 mensagens preexistentes da fixture

Não são deste trabalho, mas ajudam a ler as saídas. Repartição (do `details` de qualquer `.result.json`):

```
   21 Warning ServerActionInScreenAccessibleByEveryone
   18 Warning ExpressionComparingDifferentIdentifiers
    9 Warning UnusedElement
    6 Warning ConsecutiveServerInteractions
    1 Hint UnusedElement
    1 Hint ConsecutiveServerInteractions
    1 Warning InvalidResourceURL_Offline
```

As 18 de `ExpressionComparingDifferentIdentifiers` são todas o mesmo padrão do WrightFlood,
`Check GetUserId() = NullIdentifier() (IfNode)` — no ODC os dois lados não têm o mesmo tipo de identificador.
É código do módulo do cliente, não do Anvil; deixei como está.

## Bloqueios

Nenhum. Não precisei de nada que o kernel não tivesse, e por isso
`C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-c\BLOCKER.md` não foi criado.
Nada foi editado em `Verbs.cs`, `JobRunner.cs`, `AGENTS.md`, `CLAUDE.md` ou `*.csproj`.

## Fora do brief

- Rodei `dotnet test tests\Anvil.Tests.Odc -c Release` (acima) porque a suíte descobre os jobs por pasta: sem isso eu
  estaria entregando seis testes novos sem saber se a suíte da faixa continua verde. Não editei nenhum teste.
- Consultei o catálogo Verify do ODC (`anvil-odc verify-catalog --id ...`) para provar a diferença 2 com o texto da
  instalação em vez de com memória.

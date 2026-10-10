# Frente A — apagar com consumidores reais

**Frente A — estado: concluída** (as cinco entregas do brief existem e passam; duas ressalvas, ambas registradas
abaixo e em `lab\cobertura-a\BLOCKER.md`: a porta 4547 estava ocupada, e o ODC precisa de `force` para apagar
atributo por causa de uma diferença de plataforma que só se corrige no kernel).

**Branch/worktree**: `cov/a` em `C:\Users\andre\Anvil-cov-a`; commits `6918937` (faixa O11), `d5c20e0` (faixa ODC)
e o commit deste relatório.

---

## Como tudo foi rodado (leia antes de reproduzir)

A porta do worker ODC da frente A (`4547`) e a do worker O11 da faixa `ss4` (`4517`) **já estavam ocupadas** quando
a frente começou — pelos workers do repositório principal `C:\Users\andre\Anvil`, não por outra frente:

```
> Get-CimInstance Win32_Process -Filter "ProcessId=32720 OR ProcessId=61680" | Select ProcessId,CommandLine
ProcessId   : 61680
CommandLine : dotnet C:\Users\andre\Anvil\.local\cli\anvil.dll serve --port 4517 --log-dir C:\Users\andre\Anvil\.local
ProcessId   : 32720
CommandLine : dotnet C:\Users\andre\Anvil\.local\lane-odc\cli\anvil-odc.dll serve --port 4547
              --log-dir C:\Users\andre\Anvil\.local\lane-odc
```

`scripts/build.py` e `scripts/build_odc.py` começam por `stop(porta)`, ou seja, teriam derrubado o worker do
integrador no meio do trabalho dele em `Verbs.cs`. E usar a porta sem derrubar seria pior ainda: os jobs daqui
rodariam **no worker do outro repositório, com o código dele**, que é exatamente o acidente que o plano descreve.
Então nenhuma porta foi tocada e todos os jobs rodaram em **processo frio**, com o CLI construído neste worktree:

```powershell
cd C:\Users\andre\Anvil-cov-a
$env:ANVIL_LANE = 'ss4'
$env:ANVIL_ODC_PORT = '4547'
dotnet build src\Anvil.Cli     -c Release -o .local\cli          -nologo -v q   # build ok
dotnet build src\Anvil.Cli.Odc -c Release -o .local\lane-odc\cli -nologo -v q   # build ok
$env:ANVIL_WORKER = '0'         # faixa O11 em processo frio
$env:ANVIL_ODC_NO_WORKER = '1'  # faixa ODC em processo frio
```

Custo: ~8 s por job na O11 e ~13 s na ODC (a saída diz `via process` / `via processo frio odc`), contra ~0,4 s com
worker quente. O resultado é o mesmo — é o mesmo `Dispatch`.

---

## Jobs entregues

| Job | O que prova |
|---|---|
| `tests/jobs/delete-data-consumers.json` | apagar o atributo `Contact.Email`, que tem **quatro** consumidores reais (filtro de aggregate, Expression da tela, argumento de Execute e Input do formulário): sai um a um, na ordem certa, e o delete passa **sem force** |
| `tests/jobs-negative/delete-attribute-in-use.json` | a **recusa** do mesmo delete, com a mensagem nomeando os dois consumidores |
| `tests/jobs/delete-logic-consumers.json` | apagar a server action `Contact_Save`, chamada por outra server action e pela screen action da tela: o verbo `replace` reponta os dois consumidores para `Contact_Store` e só então o delete passa sem force |
| `tests/jobs-negative/delete-action-in-use.json` | a **recusa** do mesmo delete, nomeando os dois chamadores |
| `tests/jobs/delete-interface-consumers.json` | apagar um **widget** consumido por outro (`Label.TargetWidget` → `Email_Input`) e um **bloco próprio instanciado** numa tela: consumidor primeiro, alvo depois, sem force |
| `tests/jobs-negative/delete-block-in-use.json` | a **recusa** do delete do bloco enquanto há instância |
| `tests/jobs-negative/delete-widget-in-use.json` | a **recusa** do delete do Input enquanto o Label aponta para ele |
| `tests/jobs-odc/delete-data-consumers.json` | o equivalente de dados na faixa ODC, sobre `wrightflood-personal-r8.oml`: um consumidor **repontado** (para `Title`) e dois **removidos**; o delete final precisa de `force` por diferença de plataforma (abaixo) |
| `tests/jobs-odc/delete-data-in-use.json` | a **recusa** na faixa ODC, nomeando filtro, Assign e o registro de exemplo |
| `tests/jobs-odc/delete-logic-consumers.json` | o equivalente de lógica na faixa ODC: `WfProof_Save` chamada por outra server action e pela screen action de uma tela nova; `replace` e delete limpo **sem force** |
| `tests/jobs-odc/delete-logic-in-use.json` | a **recusa** na faixa ODC, nomeando os dois chamadores |

Os quatro negativos da faixa O11 já são cobertos automaticamente pelo `NegativeJobTests` (ele varre
`tests/jobs-negative` e exige que o job falhe com cada trecho de `expectError`). Os dois negativos da faixa ODC
são conferidos à mão: não há runner de negativos naquela faixa (ver "Bloqueios").

---

## Provas

### 1. `tests/jobs/delete-data-consumers.json` — dados, O11

```
> python scripts\run_job.py tests\jobs\delete-data-consumers.json
== delete-data-consumers.json: ok=True {'ops': 38, 'objects': 11309, 'isValid': True, 'messages': 0, 'applyMs': 1366}
   via process | 8422 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

Os quatro consumidores reais, antes (recortado; `derived:true` é o que o Studio mantém sozinho e não conta):

```json
{"target":"IEntityAttribute 'Email'","count":6,"real":4,
 "entries":[
  {"type":"IExpression","text":"GetContactById.List.Current.Contact.Email","path":".../IExpression:EmailEcho/CustomProperty:Value/IExpression","derived":false},
  {"type":"IExpression","text":"GetContactById.List.Current.Contact.Email","path":".../IForm:ContactForm/IMobileWidget:content/IInput:Email_Input/CustomProperty:Variable/IExpression","derived":false},
  {"type":"IExpression","text":"GetContactById.List.Current.Contact.Email","path":".../IScreenAction:Save/IExecuteServerActionNode:NotifyByEmail/IArgument/IExpression","derived":false},
  {"type":"IExpression","text":"Contact.Email <> \"\"","path":".../IScreenAggregate:GetContactById/DataTable/ICombineSourcesOperation:Contacts/IFilter/IExpression","derived":false},
  {"type":"AttributeReference","path":".../IAddSourceOperation:Contact/AttributeReference:Email","derived":true},
  {"type":"SampleRecordAttributeValue","path":"IServerEntity:Contact/SampleRecord/SampleRecordAttributeValue","derived":true}]}
```

A saída dos deletes, na ordem, e o `usages` que zera antes do delete do atributo:

```json
delete {"deleted":{"type":"IExpression","name":"EmailEcho"},"brokenConsumers":0}
delete {"deleted":{"type":"IFilter","name":null},"brokenConsumers":0}
delete {"deleted":{"type":"IExecuteServerActionNode","name":"NotifyByEmail"},"brokenConsumers":0}
delete {"deleted":{"type":"IServerAction","name":"Contact_NotifyByEmail"},"brokenConsumers":0}
delete {"deleted":{"type":"IInput","name":"Email_Input"},"brokenConsumers":0}
usages {"target":"IEntityAttribute 'Email'","count":2,"real":0,
        "byType":{"AttributeReference":1,"SampleRecordAttributeValue":1}}
delete {"deleted":{"type":"IEntityAttribute","name":"Email"},"brokenConsumers":0}
```

### 2. `tests/jobs-negative/delete-attribute-in-use.json` — a recusa (dados, O11)

```
> python scripts\run_job.py tests\jobs-negative\delete-attribute-in-use.json
== delete-attribute-in-use.json: ok=False op #2 (delete ): InvalidOperationException: delete: refused,
IEntityAttribute 'Email' is used by 2 consumer(s):
IMobileFlow:MainFlow/IMobileScreen:ContactDetail/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IForm:ContactForm/IMobileWidget:content/IInput:Email_Input/CustomProperty:Variable/IExpression;
IMobileFlow:MainFlow/IMobileScreen:ContactDetail/IScreenAggregate:GetContactById/DataTable/ICombineSourcesOperation:Contacts/IFilter/IExpression
(list them with usages, fix or remove those usages, or pass "force": true to break them)
   via process | 7667 ms de parede
```

A mensagem nomeia **cada** consumidor pelo caminho completo (tela / widget / propriedade), que é o que faz dela
uma instrução e não um "não deu".

### 3. `tests/jobs/delete-logic-consumers.json` — lógica, O11 (com `replace`)

```
> python scripts\run_job.py tests\jobs\delete-logic-consumers.json
== delete-logic-consumers.json: ok=True {'ops': 41, 'objects': 11340, 'isValid': True, 'messages': 0, 'applyMs': 1445}
   via process | 9826 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

```json
usages  {"target":"IServerAction 'Contact_Save'","count":2,"real":2,"entries":[
         {"type":"IExecuteServerActionNode","name":"SaveOne","path":"IServerAction:Contact_Import/IExecuteServerActionNode:SaveOne"},
         {"type":"IExecuteServerActionNode","name":"Contact_Save","path":".../IScreenAction:Save/IExecuteServerActionNode:Contact_Save"}]}
replace {"replaced":"IServerAction 'Contact_Save'","with":"IServerAction 'Contact_Store'",
         "consumers":2,"rewired":2,"stillPointingAtFrom":0,"consumersOfTo":2,
         "touched":[{"referer":"IServerAction:Contact_Import/IExecuteServerActionNode:SaveOne"},
                    {"referer":".../IScreenAction:Save/IExecuteServerActionNode:Contact_Store"}]}
usages  {"target":"IServerAction 'Contact_Save'","count":0,"real":0,"entries":[]}
usages  {"target":"IServerAction 'Contact_Store'","count":2,"real":2}
delete  {"deleted":{"type":"IServerAction","name":"Contact_Save"},"brokenConsumers":0}
find    []
```

Detalhe que vale anotar: o `replace` **renomeia o nó consumidor** — o `IExecuteServerActionNode` da screen action
chamava-se `Contact_Save` e passou a `Contact_Store`, mantendo a mesma chave (`UE1Go1zt70Ct38N_OJVsBg` antes e
depois). Quem tinha o nome antigo escrito numa expressão não quebra, porque a ligação é por chave.

### 4. `tests/jobs-negative/delete-action-in-use.json` — a recusa (lógica, O11)

```
> python scripts\run_job.py tests\jobs-negative\delete-action-in-use.json
== delete-action-in-use.json: ok=False op #14 (delete ): InvalidOperationException: delete: refused,
IServerAction 'Contact_Save' is used by 2 consumer(s):
IMobileFlow:MainFlow/IMobileScreen:ContactDetail/IScreenAction:Save/IExecuteServerActionNode:Contact_Save;
IServerAction:Contact_Import/IExecuteServerActionNode:SaveOne
(list them with usages, fix or remove those usages, or pass "force": true to break them)
   via process | 7228 ms de parede
```

### 5. `tests/jobs/delete-interface-consumers.json` — interface, O11

```
> python scripts\run_job.py tests\jobs\delete-interface-consumers.json
== delete-interface-consumers.json: ok=True {'ops': 20, 'objects': 11313, 'isValid': True, 'messages': 0, 'applyMs': 1170}
   via process | 9086 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

```json
usages {"target":"IMobileBlock 'ContactCard'","count":1,"real":1,"entries":[
        {"type":"IMobileBlockInstanceWidget","name":"ContactCardInstance",
         "path":".../IMobileScreen:ContactDetail/.../IPlaceholderContentWidget:MainContent/IMobileBlockInstanceWidget:ContactCardInstance"}]}
usages {"target":"IInput 'Email_Input'","count":1,"real":1,"entries":[
        {"type":"CustomProperty","name":"TargetWidget","path":".../ILabel:EmailLabel/CustomProperty:TargetWidget"}]}
delete {"deleted":{"type":"ILabel","name":"EmailLabel"},"brokenConsumers":0}
delete {"deleted":{"type":"IInput","name":"Email_Input"},"brokenConsumers":0}
delete {"deleted":{"type":"IMobileBlockInstanceWidget","name":"ContactCardInstance"},"brokenConsumers":0}
delete {"deleted":{"type":"IMobileBlock","name":"ContactCard"},"brokenConsumers":0}
```

### 6. As duas recusas de interface

```
> python scripts\run_job.py tests\jobs-negative\delete-block-in-use.json
== delete-block-in-use.json: ok=False op #9 (delete ): InvalidOperationException: delete: refused,
IMobileBlock 'ContactCard' is used by 1 consumer(s):
IMobileFlow:MainFlow/IMobileScreen:ContactDetail/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IMobileBlockInstanceWidget:ContactCardInstance
(list them with usages, fix or remove those usages, or pass "force": true to break them)

> python scripts\run_job.py tests\jobs-negative\delete-widget-in-use.json
== delete-widget-in-use.json: ok=False op #4 (delete ): InvalidOperationException: delete: refused,
IInput 'Email_Input' is used by 1 consumer(s):
IMobileFlow:MainFlow/IMobileScreen:ContactDetail/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IForm:ContactForm/IMobileWidget:content/ILabel:EmailLabel/CustomProperty:TargetWidget
(list them with usages, fix or remove those usages, or pass "force": true to break them)
```

### 7. `tests/jobs-odc/delete-data-consumers.json` — dados, ODC

```
> python scripts\run_job.py tests\jobs-odc\delete-data-consumers.json --lane odc --quiet
== delete-data-consumers.json: ok=True {'ops': 50, 'objects': 59333, 'isValid': True, 'messages': 55, 'applyMs': 4164}
   via processo frio odc | 13702 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

As 55 mensagens são todas **preexistentes** na fixture do WrightFlood (`ExpressionComparingDifferentIdentifiers`,
`ServerActionInScreenAccessibleByEveryone`, `UnusedElement` de structures); **zero** novas, nenhuma declarada.

```json
usages {"target":"IEntityAttribute 'Body'","count":5,"real":4,"entries":[
  {"type":"IRecordAttributeValue","path":"IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue","derived":false},
  {"type":"ITextBasedExpression","text":"ReadNotices.List.Current.WfProofNotice.Body","path":"IServerAction:WfProof_Digest/IExecuteServerActionNode:Send/IArgument/ITextBasedExpression","derived":false},
  {"type":"AttributeReference","path":"IServerAction:WfProof_Digest/IAggregateNode:ReadNotices/DataTable/IAddSourceOperation:WfProofNotice/AttributeReference:Body","derived":true},
  {"type":"ITextBasedExpression","text":"WfProofNotice.Body <> \"\"","path":".../ICombineSourcesOperation:WfProofNotices/IFilter/ITextBasedExpression","derived":false},
  {"type":"ITextBasedExpression","text":"ReadNotices.List.Current.WfProofNotice.Body","path":"IServerAction:WfProof_Digest/IAssignNode/IAssignment/ITextBasedExpression","derived":false}]}

delete {"deleted":{"type":"IFilter"},"brokenConsumers":0}                     <- REMOVER o filtro
                                                                             <- REPONTAR o Assign para Title (op set)
delete {"deleted":{"type":"IExecuteServerActionNode","name":"Send"},"brokenConsumers":0}
delete {"deleted":{"type":"IServerAction","name":"WfProof_Send"},"brokenConsumers":0}
usages {"target":"IEntityAttribute 'Body'","count":2,"real":1,"entries":[
  {"type":"IRecordAttributeValue","path":"IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue","derived":false},
  {"type":"AttributeReference","path":"...AttributeReference:Body","derived":true}]}
delete {"deleted":{"type":"IEntityAttribute","name":"Body"},"brokenConsumers":1}
```

O `real:1` que sobra e o `brokenConsumers:1` **não são um consumidor de autoria**: são o registro de exemplo da
entidade, que no ODC se chama `IRecord`/`IRecordAttributeValue` e que o kernel ainda não reconhece como derivado
(diferença de plataforma, abaixo). Por isso, e só por isso, o delete final leva `"force": true`, com `_why` no job.
O módulo termina válido e sem mensagem nova, como o plano exige de quem usa `force`.

### 8. `tests/jobs-odc/delete-data-in-use.json` — a recusa (dados, ODC)

```
> python scripts\run_job.py tests\jobs-odc\delete-data-in-use.json --lane odc --quiet
"error": "op #20 (delete ): InvalidOperationException: delete: refused, IEntityAttribute 'Body' is used by
3 consumer(s): IServerAction:WfProof_Digest/IAssignNode/IAssignment/ITextBasedExpression;
IServerAction:WfProof_Digest/IAggregateNode:ReadNotices/DataTable/ICombineSourcesOperation:WfProofNotices/IFilter/ITextBasedExpression;
IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue (list them with usages, fix or remove those usages,
or pass \"force\": true to break them)"
```

### 9. `tests/jobs-odc/delete-logic-consumers.json` — lógica, ODC (com `replace`, sem `force`)

```
> python scripts\run_job.py tests\jobs-odc\delete-logic-consumers.json --lane odc --quiet
== delete-logic-consumers.json: ok=True {'ops': 71, 'objects': 59396, 'isValid': True, 'messages': 55, 'applyMs': 4209}
   via processo frio odc | ~14 s de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

```json
usages  {"target":"IServerAction 'WfProof_Save'","count":2,"real":2,"entries":[
         {"name":"SaveOne","path":"IServerAction:WfProof_Import/IExecuteServerActionNode:SaveOne"},
         {"name":"SaveFromScreen","path":"IMobileFlow:MainFlow/IMobileScreen:WfProofScreen/IScreenAction:SaveIt/IExecuteServerActionNode:SaveFromScreen"}]}
replace {"replaced":"IServerAction 'WfProof_Save'","with":"IServerAction 'WfProof_Store'",
         "consumers":2,"rewired":2,"stillPointingAtFrom":0,"consumersOfTo":2}
usages  {"target":"IServerAction 'WfProof_Save'","count":0,"real":0,"entries":[]}
delete  {"deleted":{"type":"IServerAction","name":"WfProof_Save"},"brokenConsumers":0}
find    []
```

### 10. `tests/jobs-odc/delete-logic-in-use.json` — a recusa (lógica, ODC)

```
> python scripts\run_job.py tests\jobs-odc\delete-logic-in-use.json --lane odc --quiet
"error": "op #46 (delete ): InvalidOperationException: delete: refused, IServerAction 'WfProof_Save' is used by
2 consumer(s): IServerAction:WfProof_Import/IExecuteServerActionNode:SaveOne;
IMobileFlow:MainFlow/IMobileScreen:WfProofScreen/IScreenAction:SaveIt/IExecuteServerActionNode:SaveFromScreen
(list them with usages, fix or remove those usages, or pass \"force\": true to break them)"
```

### 11. Suíte: `NegativeJobTests` (os quatro negativos novos) e `GuideTests`

```
> dotnet test tests\Anvil.Tests --filter "FullyQualifiedName~NegativeJobTests|FullyQualifiedName~GuideTests"
Com falha! - Com falha: 1, Aprovado: 22, Ignorado: 0, Total: 23, Duração: 15 s - Anvil.Tests.dll (net8.0)

Anvil.Tests.GuideTests.EveryTestJobIsMentionedInTheGuide [FAIL]
  jobs sem referencia no AGENTS.md (uma LLM fria nao os encontra):
  delete-data-consumers, delete-interface-consumers, delete-logic-consumers
```

A única falha é **essa**, e é esperada: os três jobs novos de `tests/jobs` ainda não estão citados no `AGENTS.md`,
que esta frente não pode editar (regra 3). Ela some com a linha abaixo. Os quatro jobs negativos novos já passam
(`NegativeJobTests`: o job falha e o texto contém cada trecho de `expectError`).

---

## Linha para o AGENTS.md (o integrador acrescenta)

Na tabela da seção 1, na linha **Refatorar**, na coluna "Copie de (tests/jobs)", acrescentar aos exemplos já
citados:

```
`delete-data-consumers.json`, `delete-logic-consumers.json`, `delete-interface-consumers.json`
```

E, logo depois do parágrafo **"Repontar consumidores (op `replace`)"** da seção 2, acrescentar este parágrafo
(é ele que cita também os negativos e a faixa ODC, e que faz o `GuideTests` ficar verde):

```markdown
**Apagar com consumidores (op `delete`).** O `delete` recusa quando o alvo tem consumidores reais e a mensagem
NOMEIA cada um pelo caminho (`delete: refused, <alvo> is used by N consumer(s): <caminho>; ... or pass "force":
true to break them`); usos derivados (lista de atributos do aggregate, registo de exemplo) não contam. As duas
metades estão provadas: o caminho limpo em `delete-data-consumers.json` (atributo usado por filtro de aggregate,
Expression, argumento e Input: sai um a um), `delete-logic-consumers.json` (action chamada por outra action e por
uma tela: `replace` reponta os dois e só então o delete passa) e `delete-interface-consumers.json` (Label com
`TargetWidget` e bloco próprio instanciado); a recusa em `delete-attribute-in-use.json`, `delete-action-in-use.json`,
`delete-block-in-use.json` e `delete-widget-in-use.json`. Para apagar um nó no meio de um fluxo, **religue o
predecessor antes**: o conector de entrada conta como consumidor do nó. Na faixa ODC, `tests/jobs-odc/delete-data-consumers.json`
e `tests/jobs-odc/delete-logic-consumers.json` (limpos) e `delete-data-in-use.json`/`delete-logic-in-use.json`
(recusas, conferidas à mão).
```

---

## Diferenças de plataforma encontradas

### a) O registro de exemplo do ODC não é reconhecido como uso derivado

`Verbs.cs:977` trata como derivado o que contém `AttributeReference`, `SampleRecord` ou `IAddSourceOperation:`.
Na faixa O11 o registro de exemplo de uma entidade aparece como
`IServerEntity:Contact/SampleRecord/SampleRecordAttributeValue` → `derived: true`. **No ODC o mesmo objeto é
`IRecord`/`IRecordAttributeValue`** → `derived: false`. Resultado: na faixa ODC nenhum atributo de entidade pode
ser apagado sem `force`, mesmo sem nenhum consumidor de autoria. Erro colado (antes do contorno, já com os três
consumidores reais removidos/repontados):

```
op #46 (delete ): InvalidOperationException: delete: refused, IEntityAttribute 'Body' is used by 1 consumer(s):
IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue (list them with usages, fix or remove those usages,
or pass "force": true to break them)
```

**O que a frente fez**: não consertou o kernel (regra 3 — é uma linha em `IsDerived`, mas é `Verbs.cs`). O job usa
`"force": true` no delete final, com `_why` explicando exatamente isto, e termina com o módulo válido e zero
mensagens novas. Registrado em `lab\cobertura-a\BLOCKER.md`.

### b) Expressões do ODC são `ITextBasedExpression`

Onde a faixa O11 devolve `IExpression` no `usages`/na mensagem de recusa, o ODC devolve `ITextBasedExpression`
(mesmo papel, mesmo `text`). Não atrapalha nada, mas quem escrever `expectError` para as duas faixas não pode
casar o nome do tipo. Já está refletido nos `expectError` dos jobs ODC.

### c) O que **não** é diferença (conferido, para ninguém reabrir)

- O verbo `replace` funciona igual nas duas faixas, inclusive renomeando o nó consumidor e mantendo a chave.
- Aggregates dentro de server action (`IAggregateNode` + `IAliasedSource` + `IFilter`) funcionam no ODC (o
  `FeaturesProvider` já é inicializado pelo adaptador, como diz `2026-09-17-ws1-diferencas.md`).
- Uma screen action do ODC chamando uma server action **não pública** não gera
  `ServerActionInScreenAccessibleByEveryone` novo (o aviso da fixture é sobre actions públicas).
- `set Public true` numa server action evita o `UnusedUserAction` do ODC sem precisar declarar mensagem — foi assim
  que `WfProof_Digest` e `WfProof_Import` ficaram sem aviso, em vez de declarar como fez `refactor-replace-action.json`.

---

## Bloqueios

1. **Porta 4547 ocupada no início** (pelo worker do repositório principal, não por outra frente). O plano manda
   parar e registrar; a frente registrou e seguiu **em processo frio**, sem tomar nem derrubar a porta. Detalhe e
   comandos em `lab\cobertura-a\BLOCKER.md`. Para devolver as portas às frentes, pare os dois workers em
   `C:\Users\andre\Anvil` (`python scripts\anvil_worker.py stop`, `python scripts\odc_worker.py stop`).
2. **`IsDerived` não conhece `IRecordAttributeValue`** (diferença (a) acima): correção de uma linha em `Verbs.cs`,
   proibida a esta frente. Contornado com `force` documentado.
3. **Não há runner automático de jobs negativos na faixa ODC**: `NegativeJobTests` varre só `tests/jobs-negative` e
   roda pelo `ModelHost` da O11. As duas recusas do ODC ficaram em `tests/jobs-odc/*-in-use.json`, com o mesmo campo
   `expectError`, conferidas à mão (provas 8 e 10). Criar o runner mexeria em `tests/Anvil.Tests` — decisão do
   integrador.
4. **`AGENTS.md`**: os três jobs novos de `tests/jobs` deixam `GuideTests.EveryTestJobIsMentionedInTheGuide`
   vermelho até o integrador acrescentar a linha acima. É o único teste vermelho.

---

## Fora do brief

- **Dois jobs negativos a mais do que o brief pedia** (`delete-widget-in-use.json` além de `delete-block-in-use.json`,
  e os dois `*-in-use.json` da faixa ODC). Motivo: o brief diz que "a mensagem de recusa faz parte da prova", e a
  recusa aborta a transação — ela não cabe no mesmo job do caminho limpo. Em vez de provar a recusa só no relatório,
  cada recusa virou um job com `expectError`, que é o mecanismo que o repositório já tinha e que o
  `NegativeJobTests` roda sozinho a partir de agora (na faixa O11).
- **`set Public true` na entidade `Contact`** dentro de `delete-logic-consumers.json`. Não era o assunto, mas sem
  isso o Verify dá erro `InvalidPublic_ActionParameterNotPublic` ("The Action 'Contact_Import' is public but its
  parameter 'Contact' is defined as a record of type 'Contact' Entity that is not public"), e a alternativa era
  declarar um `UnusedUserAction` para calar uma action solta — o que o plano proíbe. Fica registrado porque é uma
  regra de plataforma útil: **action pública com parâmetro record exige a entidade pública**.

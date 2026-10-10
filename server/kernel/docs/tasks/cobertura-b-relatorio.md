# Frente B — eventos de bloco (as duas faixas) e processo (O11)

**Estado: concluída.** Os quatro jobs do brief existem, correm e passam: `ok=True`, `isValid=True`,
`accepted=True`, zero mensagens inesperadas e zero mensagens declaradas (não precisei declarar nenhuma).

**Branch/worktree:** `cov/b` em `C:\Users\andre\Anvil-cov-b`. Faixa O11 `ss5` (worker 4537), faixa ODC na porta
`4557` (a 4547 é da Frente A e a 4537 estava livre quando comecei). Commits: `78df316` (evento de bloco nas duas
faixas), `8bec876` (processo BPT editado e atividade apagada) e o commit deste relatório.

## Jobs entregues

| Job | O que prova |
|---|---|
| `tests/jobs/block-events-reactive.json` | o ciclo inteiro do evento de bloco: o bloco `RatingPicker` declara `OnRate` com dois parâmetros, dispara-o com um `ITriggerNode` numa screen action do próprio bloco, e a tela `RatingDemo` instancia o bloco, liga o handler e **usa** os dois parâmetros recebidos (grava-os em variáveis da tela e mostra-os) |
| `tests/jobs/block-events-update.json` | a mudança de contrato sobre o primeiro (`base: job:block-events-reactive`): `OnRate` ganha o parâmetro `RatedAt` e passa a `IsMandatory True`; o consumidor mantém a **mesma chave** de `IEventHandler`, o argumento novo tem de ser preenchido dos dois lados, e ninguém se perde (`usages` = 2 antes e depois) |
| `tests/jobs-odc/block-events.json` | o equivalente na faixa ODC, sobre o WrightFlood do tenant pessoal: bloco + evento + trigger por verbos nativos, e a instância ligada ao evento **pela autoria visual** (`op html` com `parent`, `<Block name=… @OnRate="WfRateReceived">`), como manda a secção 3.5 |
| `tests/jobs/process-edit-delete.json` | processo (BPT) **editado** e uma atividade **apagada**, sobre `job:process-human-traditional`: muda a expressão `Detail` e as condições da atividade humana (`DueDate`, `AllowSkip`, `Instructions`), acrescenta a atividade automática `NotifyOwner` entre `Review` e `End`, e apaga `Review`, que tinha consumidor real |

Arquivo de apoio novo: `tests/html/visual/block-event.html` (o fragmento usado pelo job ODC).

Provas negativas (aquilo que **quebra**; abortam ou invalidam o job, por isso vivem fora de `tests/`, em
`.local/lane-ss5/`, como manda a secção 3.4 do guia): `probe-block-event-break.json`,
`probe-block-event-mandatory.json`, `probe-process-delete-refusal.json`. As saídas estão coladas abaixo.

## Provas (comando e saída colados)

Em todas as sessões: `cd C:\Users\andre\Anvil-cov-b; $env:ANVIL_LANE='ss5'; $env:ANVIL_ODC_PORT='4557'`.
`$py = C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`.

### 1. `tests/jobs/block-events-reactive.json`

```
> & $py scripts\run_job.py tests\jobs\block-events-reactive.json
== block-events-reactive.json: ok=True {'ops': 73, 'objects': 11279, 'isValid': True, 'messages': 0, 'applyMs': 216}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IBlockEvent OnRate {..., "IsValid": "True", "Description": "Disparado quando o utilizador escolhe uma nota no bloco", "Name": "OnRate", "InputParameters": 2}
   get ITriggerNode RaiseOnRate {..., "Connectors": 1, "IncomingConnectors": 1, "Event": "@vy3bbYWOVECYVeUq_hcD2w", "Name": "RaiseOnRate", "Target": "@h0MEW_o7rkCGsMJn4Xkaog", "Arguments": 2}
   get IEventHandler  {..., "Event": "@vy3bbYWOVECYVeUq_hcD2w", "Handler": "@XDC_JywWFEOhYnQlJDKOzw", "Arguments": 2}
   usages {"target": "IBlockEvent 'OnRate'", "count": 2, "real": 2, "byType": {"IEventHandler": 1, "ITriggerNode": 1}, "entries": [
     {"type": "IEventHandler", ..., "path": "IMobileFlow:MainFlow/IMobileScreen:RatingDemo/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IMobileBlockInstanceWidget:RatingPicker1/IEventHandler", "derived": false},
     {"type": "ITriggerNode", "name": "RaiseOnRate", ..., "path": "IMobileFlow:MainFlow/IMobileBlock:RatingPicker/IScreenAction:Rate/ITriggerNode:RaiseOnRate", "derived": false}]}
```

O `dump` mostra os dois lados ligados pelo mesmo evento (saída integral em
`.local/lane-ss5/provas/block-events-reactive.out.txt` e no `.result.json`):

```
   IMobileBlock RatingPicker
     IBlockEvent OnRate
       IInputParameter Rating
       IInputParameter Comment
     IScreenAction Rate
       ...
       ITriggerNode RaiseOnRate
           IExpression  = "nota dada em " + Caption
           IExpression  = Score
   IMobileScreen RatingDemo
     IScreenAction RatingPicker1_OnRate
       IInputParameter Rating
       IInputParameter Comment
       IAssignNode
         IAssignment
           IExpression  = LastRating
           IExpression  = Rating
         IAssignment
           IExpression  = LastComment
           IExpression  = Comment
     ...
         IMobileBlockInstanceWidget RatingPicker1
             IExpression  = "Que nota da a esta estadia?"
           IEventHandler
               IExpression  = Comment
               IExpression  = Rating
```

### 2. `tests/jobs/block-events-update.json`

```
> & $py scripts\run_job.py tests\jobs\block-events-update.json
== block-events-update.json: ok=True {'ops': 22, 'objects': 11298, 'isValid': True, 'messages': 0, 'applyMs': 359}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

   (antes)  get IBlockEvent OnRate  {..., "Name": "OnRate", "InputParameters": 2}                       # sem IsMandatory
   (meio)   get ITriggerNode RaiseOnRate {..., "Name": "RaiseOnRate", ..., "Arguments": 3}              # o PRODUTOR ganha o argumento novo sozinho, vazio
   (meio)   get IEventHandler  {"ObjectKey": "uxKrUBWnQ0GEh0VXC9sk6A", ..., "Handler": "@kQ_SxmB++kizO2VmCwrA_w", "Arguments": 2}   # o CONSUMIDOR ainda nao
   (depois) get IBlockEvent OnRate  {..., "IsMandatory": "True", "Name": "OnRate", "InputParameters": 3}
   (depois) get IEventHandler  {"ObjectKey": "uxKrUBWnQ0GEh0VXC9sk6A", ..., "Handler": "@kQ_SxmB++kizO2VmCwrA_w", "Arguments": 3}   # MESMA chave, agora com os 3
   usages {"target": "IBlockEvent 'OnRate'", "count": 2, "real": 2, "byType": {"ITriggerNode": 1, "IEventHandler": 1}, ...}   # igual antes e depois
```

**O que acontece a quem já consumia** (prova negativa, o mesmo contrato sem migrar ninguém):

```
> & $py scripts\run_job.py .local\lane-ss5\probe-block-event-break.json
== probe-block-event-break.json: ok=True {'ops': 5, 'objects': 11281, 'isValid': False, 'messages': 1, 'applyMs': 140}
    Error ArgumentRequiredExpression: Required Property Value | A valid expression must be set for parameter 'RatedAt'.
      @ Headless_UI (ESpace) / MainFlow (MobileFlow) / RatingPicker (MobileBlock) / Rate (ScreenAction) / RaiseOnRate (TriggerNode) / Argument
    Hint ArgumentRequiredExpression: Preencher o argumento obrigatorio, ou marcar o Input Parameter como Is Mandatory=No.
   get IEventHandler  {..., "IsValid": "True", ..., "Arguments": 2}
```

Ou seja: **quem quebra é o produtor**, não o consumidor. O handler da tela continua válido com os argumentos
antigos (a plataforma simplesmente não lhe entrega o parâmetro novo); o `ITriggerNode` do bloco é que fica com um
argumento obrigatório por preencher. Quem muda um contrato de evento tem de olhar primeiro para quem dispara.

E o que `IsMandatory: True` cobra (prova negativa, instância nova sem handler):

```
> & $py scripts\run_job.py .local\lane-ss5\probe-block-event-mandatory.json
== probe-block-event-mandatory.json: ok=True {'ops': 3, 'objects': 11302, 'isValid': False, 'messages': 1, 'applyMs': 131}
    Error EventHandlerRequiredAction: Required Property Value | OnRate event handler must be set.
      @ MainFlow (MobileFlow) / RatingDemo (MobileScreen) / MobileBlockInstanceWidget / MainContent (PlaceholderContentWidget) / RatingPicker2 (MobileBlockInstanceWidget) / EventHandler
    Hint EventHandlerRequiredAction: Definir o Handler do evento obrigatorio, ou tornar o evento do Block opcional (Is Mandatory=No).
```

Quem **já** tinha handler ligado não sente a obrigatoriedade (é o caso do `block-events-update`, que fica válido);
quem instanciar o bloco a partir daí é que passa a ser obrigado.

### 3. `tests/jobs-odc/block-events.json` (faixa ODC, porta 4557)

```
> & $py scripts\run_job.py tests\jobs-odc\block-events.json --lane odc
== block-events.json: ok=True {'ops': 68, 'objects': 59523, 'isValid': True, 'messages': 55, 'applyMs': 1407}
   via worker odc | 4688 ms de parede
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IBlockEvent OnRate {..., "Descriptor": "ServiceStudio.Model.WebBlockCustomEvent+ClassDescriptor", "IsValid": "True", "Referrers": 2, "Name": "OnRate", "IsMandatory": "True", "InputParameters": 2}
   get ITriggerNode RaiseOnRate {..., "Descriptor": "ServiceStudio.Model.NRNodes+TriggerEvent+ClassDescriptor", "Event": "@fbIHnXJhUEuxB7aHvrpEuA", "Name": "RaiseOnRate", "Arguments": 2}
   get IMobileBlockInstanceWidget RatingPicker1 {..., "Name": "RatingPicker1", "SourceBlock": "@GVBjiA3m6k63f6+OguZAkQ", "Arguments": 1, "EventHandlers": 1}
   get IEventHandler  {..., "Event": "@fbIHnXJhUEuxB7aHvrpEuA", "Handler": "@rorPMWjBdESORdu4_x7JbQ", "Arguments": 2}
   usages {"target": "IBlockEvent 'OnRate'", "count": 2, "real": 2, "byType": {"ITriggerNode": 1, "IEventHandler": 1}, "entries": [
     {"type": "ITriggerNode", "name": "RaiseOnRate", ..., "path": "IMobileFlow:MainFlow/IMobileBlock:WfRatingPicker/IScreenAction:Rate/ITriggerNode:RaiseOnRate", "derived": false},
     {"type": "IEventHandler", ..., "path": "IMobileFlow:MainFlow/IMobileScreen:WfRatingDemo/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IContainer:RatingPanel/IContent:content/IMobileBlockInstanceWidget:RatingPicker1/IEventHandler", "derived": false}]}
```

As 55 mensagens são **preexistentes** da fixture do WrightFlood (todas
`ExpressionComparingDifferentIdentifiers` em `GetUserId() = NullIdentifier()`); `new` = 0.

O trecho do `dump` que mostra a autoria visual a ligar o evento pelo nome (`@OnRate="WfRateReceived"`):

```
       IPlaceholderContentWidget MainContent
         IContainer RatingPanel
           IContent content
             IAdvancedHtml Span1 ... ITextWidget  = Rate this stay
             IMobileBlockInstanceWidget RatingPicker1
                 ITextBasedExpression  = "Que nota da a esta estadia?"
               IEventHandler
                   ITextBasedExpression  = Comment
                   ITextBasedExpression  = Rating
             IAdvancedHtml Span2 ... IExpression  = "Ultima nota: " + IntegerToText(LastRating) + " (" + LastComment + ")"
```

### 4. `tests/jobs/process-edit-delete.json`

```
> & $py scripts\run_job.py tests\jobs\process-edit-delete.json
== process-edit-delete.json: ok=True {'ops': 26, 'objects': 8180, 'isValid': True, 'messages': 0, 'applyMs': 378}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

   (antes)                 IProcess ApproveContact: IStartNode -> IHumanActivityNode Review -> IEndNode
                           IExpression  = "Approve contact " + ContactId
   (depois da edicao)      IHumanActivityNode Review ... IExpression  = AddDays(CurrDateTime(), 2)
                           IAutomaticActivityNode NotifyOwner
                             IStartNode -> IExecuteServerActionNode Cleanup -> IEndNode
                           IExpression  = "Aprovar contacto " + ContactId + " (revisao 2)"
   usages {"target": "IHumanActivityNode 'Review'", "count": 1, "real": 1, "byType": {"IActionConnector": 1}, "entries": [{"type": "IActionConnector", ..., "path": "IProcess:ApproveContact/IStartNode/IActionConnector", "derived": false}]}
   delete {"deleted": {"type": "IActionConnector", "name": null, "key": "zxy9isLZAUuR1gMDxcPEaA"}, "brokenConsumers": 0}
   usages {"target": "IHumanActivityNode 'Review'", "count": 0, "real": 0, "byType": {}, "entries": []}
   delete {"deleted": {"type": "IHumanActivityNode", "name": "Review", "key": "Qq9bTH8Rp0uLIQFU76q3XA"}, "brokenConsumers": 0}
   layout {"action": "ApproveContact", "rows": 5, "columns": 1, "moved": 1}
   find []                                            # a atividade humana Review deixou de existir
   get IProcess ApproveContact {..., "Detail": "\"Aprovar contacto \" + ContactId + \" (revisao 2)\"", "Nodes": 3}
   (estado final)          IProcess ApproveContact: IStartNode -> IAutomaticActivityNode NotifyOwner -> IEndNode
```

A recusa do `delete` com consumidor (aborta o job, por isso é prova à parte):

```
> & $py scripts\run_job.py .local\lane-ss5\probe-process-delete-refusal.json
== probe-process-delete-refusal.json: ok=False op #1 (delete ): InvalidOperationException:
   delete: refused, IHumanActivityNode 'Review' is used by 1 consumer(s):
   IProcess:ApproveContact/IStartNode/IActionConnector
   (list them with usages, fix or remove those usages, or pass "force": true to break them)
```

## Linha para o AGENTS.md (o integrador acrescenta)

Duas edições na tabela da secção 1 ("1. Quero criar..."). A primeira é **nova**, e é a que faz o `GuideTests`
encontrar `block-events-reactive.json` e `block-events-update.json`; sugiro pô-la logo a seguir à linha
"Padrao do OutSystems UI" (é onde um leitor procura eventos de bloco):

```
| Evento de bloco | O bloco fala com quem o instancia: `IBlockEvent` no bloco (um `IInputParameter` por parametro, `IsMandatory`), `ITriggerNode` numa screen action do bloco para disparar (`set $trg Event $ev`, argumentos em `$trg/<Param>`), e na tela `set $b/<Evento> Handler $acao` + `set $b/<Evento>/<Param> Value` (as expressoes correm no escopo do EVENTO). Mudar o contrato depois quebra **quem dispara**, nao quem consome (`ArgumentRequiredExpression` no ITriggerNode); `IsMandatory` so cobra handler a instancias novas (`EventHandlerRequiredAction`) | Blocos Reactive e Mobile | `block-events-reactive.json` (criar e consumir), `block-events-update.json` (mudar o contrato sobre o primeiro, por `job:`); na faixa ODC, `tests/jobs-odc/block-events` liga o evento pela autoria visual (`<Block name=… @Evento="Acao">`) | `usages` do evento: um `ITriggerNode` e um `IEventHandler`; Verify 0 erros |
```

A segunda **substitui** a linha "Processo (BPT)" que lá está, para citar `process-edit-delete.json` e o que se
aprendeu a editar e apagar:

```
| Processo (BPT) | Fluxo com passos automaticos e humanos, durabilidade e taskbox. Human Activity: `set $human Destination IWebScreen:Tela` e depois os inputs da tela viram argumentos `$human/<Input>`. Editar: a atividade automatica ja NASCE com Start -> End proprios (acrescenta-se o passo no meio, apagando o conector que existia); `link` entre nos de processo ACRESCENTA conector (`Targets.Add`), por isso mover um ramo e apagar o conector antigo e ligar o novo. Apagar uma atividade exige apagar antes o conector que a consome (o `usages` mostra-o como `IActionConnector` do no anterior) | Service, Reactive, Traditional; Human Activity so com tela Traditional como destino | `process-bpt.json`, `process-human-traditional.json`, `process-expense-traditional.json`, `process-edit-delete.json` (editar condicoes, acrescentar atividade, apagar atividade com consumidor) | `Detail` definido; `layout` do processo |
```

Nota: cito o job da faixa ODC **sem** a extensão (`tests/jobs-odc/block-events`) de propósito — o
`GuideTests.EveryJobMentionedInTheGuideExists` procura todo `*.json` citado dentro de `tests/jobs`,
`tests/jobs-live` e `tests/jobs-negative`, e ficaria vermelho com `block-events.json`. É a mesma convenção que a
secção 3.5 já usa para os jobs ODC.

## Diferenças de plataforma e coisas que o guia ainda não dizia

Nenhuma diferença **entre** O11 e ODC apareceu nesta frente: o mesmo desenho de evento de bloco compilou nas duas
faixas sem um único ajuste. O que apareceu foi comportamento de plataforma que o guia não registava:

1. **A atividade automática do BPT nasce com o seu próprio `Start` -> `End`.** Criar Start/End dentro dela dá:
   ```
   Error InvalidFlow_TooManyNodes: Invalid Activity Flow | More than one Start found in Activity.
     @ HeadlessTrad_UI (ESpace) / ApproveContact (Process) / NotifyOwner (AutomaticActivityNode) / Activity
   ```
   Corrigi o job: só crio o `IExecuteServerActionNode` e recorto o conector `Start -> End` que já vinha.
2. **`link` entre nós de processo acrescenta, não substitui** (`Targets.Add`, `Verbs.cs` linha 463). Para inserir
   uma atividade no meio é preciso `delete` do conector antigo primeiro. Em actions normais o `link` escreve a
   propriedade `Target` e substitui; em BPT não.
3. **Mudar o contrato de um evento quebra o produtor, não o consumidor** (as duas provas negativas acima). É o
   contrário do que se espera de "provar o que acontece com quem já consumia": o consumidor é preservado com a
   mesma chave e continua válido.
4. **O caminho `$pai/Filho` é por NOME, não por `Tipo:Nome`.** `IProcess:ApproveContact/IStartNode` falha; o erro
   é bom e lista os filhos:
   ```
   op #3 (get ): KeyNotFoundException: IProcess 'ApproveContact' has no child 'Start'
   (children: IInputParameter:ContactId, IActionSignature:LaunchApproveContact, IHumanActivityNode:Review, IStartNode, IEndNode, IExpression)
   ```
   Para nós sem nome (Start, End) use `#ITipo`, como no resto do guia.
5. **A API do ODC tem mesmo `CreateBusinessProcess`** (registo pedido pelo brief; não virou job, como o plano
   manda). Conferido nos metadados da instalação, sem abrir Studio:
   ```powershell
   > $d='C:\Program Files\OutSystems\ODC Studio\ODC Studio'
   > $txt=[Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes("$d\OutSystems.Model.dll"))
   > foreach($n in @('CreateBusinessProcess','IBusinessProcess','OutSystems.Model.BusinessProcesses.Nodes','IHumanActivityNode','IAutomaticActivityNode')){ "{0}: {1}" -f $n,$txt.Contains($n) }
   CreateBusinessProcess: True
   IBusinessProcess: True
   OutSystems.Model.BusinessProcesses.Nodes: True
   IHumanActivityNode: True
   IAutomaticActivityNode: True
   ```
   Ou seja, o ODC tem o namespace `OutSystems.Model.BusinessProcesses(.Nodes)` com os mesmos tipos de atividade —
   o kernel já o conhece o suficiente para o despromover na escolha de tipos (`Verbs.cs` linha 825, porque
   `IStartNode`/`IEndNode` colidem com os da lógica). Isto é **presença da API**, não prova de que um processo
   compila no ODC: ninguém o executou, e BPT continua a ser trabalho da faixa O11.
6. **`IDecisionNode` do BPT fica fora do alcance dos verbos hoje**: os seus ramos nascem de
   `CreateConnector(String name, IProcessNode target)`, com dois argumentos, e o `link` só conhece
   `CreateConnector` de um argumento (`Verbs.cs` linha 455) e a coleção `Targets`. Por isso a parte "mudar
   condição" do brief ficou nas condições da atividade (`DueDate`, `AllowSkip`, `Instructions`) e na expressão
   `Detail` do processo, que são condições/expressões reais e editáveis. Ligar um Decision com ramos nomeados é
   uma capacidade a acrescentar ao kernel (não a fiz: regra 3).

## Bloqueios

**Um, de ambiente, e contornado** (detalhe e provas em `C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-b\BLOCKER.md`):
hoje de manhã, entre as 08:12 e as 08:28, o **Smart App Control** desta máquina passou de avaliação para
imposição (`HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy`: `VerifiedAndReputablePolicyState=1`,
`SAC_PreviousState=2`). Desde então, qualquer DLL recém-construída é recusada:

```
> dotnet .local\lane-ss5\cli\anvil.dll --version
Unhandled exception. System.IO.FileLoadException: Could not load file or assembly
'C:\Users\andre\Anvil-cov-b\.local\lane-ss5\cli\anvil.dll'.
Uma política de Controle de Aplicativo bloqueou este arquivo. (0x800711C7)
```

`python scripts\build.py` compila com 0 erros e morre a arrancar o worker. Não desliguei nada (política de
segurança não é alçada de um agente, e o Smart App Control só se volta a ligar reinstalando o Windows). Para não
parar a frente, copiei para o meu worktree os binários que a máquina **já aceita** — os que o integrador
construiu às 08:10/08:12 — e corri tudo com eles:

```powershell
Copy-Item 'C:\Users\andre\Anvil\.local\cli\*'          .local\lane-ss5\cli  -Recurse -Force
Copy-Item 'C:\Users\andre\Anvil\.local\lane-odc\cli\*' .local\lane-odc\cli  -Recurse -Force
> dotnet .local\lane-ss5\cli\anvil.dll --version
{"ok": true, "command": "--version", "data": {"version": "1.0.0+a5cdbb7c4d3e6ce24a501e0dda4fb6d13fecfdeb"}}
```

Isto tem de ser lido nas provas: o CLI é o build de **a5cdbb7**, um commit atrás do HEAD do `cov/b` (`5d26cb3`,
verbo `replace`). Nenhum job meu usa `replace` e não toquei em C#, por isso o recorte provado não depende dessa
diferença — mas quem for mexer no kernel tem de resolver o Smart App Control primeiro, porque nenhuma frente
consegue hoje construir C# novo e correr.

Não houve nenhum bloqueio de kernel: os quatro jobs saíram com os verbos que já existem.

## Fora do brief

- **Três provas negativas** em `.local/lane-ss5/` (`probe-block-event-break`, `probe-block-event-mandatory`,
  `probe-process-delete-refusal`): o brief pedia "provar o que acontece com quem já consumia" e a resposta honesta
  só aparece num job que fica inválido, que não pode viver em `tests/`. Estão coladas acima.
- **`tests/html/visual/block-event.html`**: fragmento novo, para o job ODC ligar o evento pela autoria visual em
  vez de repetir os verbos do O11. Foi a forma de cumprir o "não contradiga a secção 3.5" do plano: o job ODC
  prova que `<Block name=… @Evento="Acao">` também liga um evento **criado no mesmo job**, não só os do catálogo
  OutSystems UI.
- **Não toquei em `docs/PROVAS.md`.** O passo 6 do laço do guia pede lá uma linha, mas as três frentes correm em
  paralelo sobre o mesmo arquivo e isso dá conflito garantido no merge; o plano substituiu esse registo por este
  relatório. Se o integrador quiser a linha, ela é: `2026-09-17 | eventos de bloco (as duas faixas) e BPT editar/apagar | 4 jobs, 0 erros, 0 mensagens novas | python scripts/run_job.py tests/jobs/block-events-reactive.json (e -update, process-edit-delete, tests/jobs-odc/block-events --lane odc)`.
- Nenhum Studio foi aberto: tudo headless, como o plano manda.

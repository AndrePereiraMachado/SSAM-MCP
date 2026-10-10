# Frente E (segunda onda) — eventos nas duas faixas

**Estado: concluída.**

Branch/worktree: `cov2/b` em `C:\Users\andre\Anvil-cov-b`; commits `b77dac3`, `c7bbf32`, `64c9df5`.

Portas usadas, em toda sessão: `ANVIL_LANE=ss4`, `ANVIL_WORKER_PORT=4627`, `ANVIL_ODC_PORT=4657`.
As duas estavam livres no início (conferido com `Get-NetTCPConnection`); nenhum bloqueio de porta.

Ponto de partida: três jobs (`block-events-reactive`, `block-events-update`, `jobs-odc/block-events`) e a
linha "Evento de bloco" da tabela da secção 1, que já prova o ciclo básico e que **mudar o contrato quebra
quem dispara, não quem consome**. Nada disso é repetido aqui.

---

## Jobs entregues (11 arquivos novos)

### Faixa O11 — `tests/jobs`

| Job | O que prova |
|---|---|
| `block-events-types-reactive.json` | O contrato do evento aguenta o vocabulário inteiro de tipos: **lista de estrutura** (`CartLine List`), **registo** (`CartLine`), **identificador de entidade** (`Product Identifier`), Decimal, Integer, Date Time, Boolean e Text — oito parâmetros num só evento. A tela usa os dois compostos de verdade: o registo por atributo e a lista como `Source` de uma `IList`. |
| `block-events-two-instances-reactive.json` | Duas instâncias do **mesmo** bloco na **mesma** tela com handlers **diferentes**; cada instância tem o seu `IEventHandler` com `Handler` apontando para screen actions distintas. O handler não precisa dos nomes do contrato (`Score`/`Label` em vez de `Rating`/`Comment`), e a expressão do argumento corre num escopo **somado**: vê o evento **e** a tela. |
| `block-events-nested-reactive.json` | Bloco **dentro** de bloco propagando o evento para cima: o consumidor do evento de baixo é um bloco, não uma tela, e o handler desse evento é quem dispara o evento de cima. A cadeia inteira fica legível nos dois `usages`. |
| `block-events-mandatory-reactive.json` | Evento obrigatório sem handler: **não é recusa e não é aviso — é erro do Verify**, e cobrado por **instância**. `expectValid: false` com as duas mensagens declaradas e o porquê. |
| `block-events-delete-reactive.json` | Apagar o evento pelo caminho limpo: a **ordem** que faz o delete passar, incluindo religar o predecessor antes de tirar o `ITriggerNode` e apagar a screen action que fica órfã. |
| `tests/jobs-negative/delete-block-event-in-use.json` | A recusa do delete, com os **três** consumidores nomeados — inclusive a instância que nem handler tem. |

### Faixa ODC — `tests/jobs-odc`

| Job | O que prova |
|---|---|
| `block-events-types.json` | O mesmo contrato de oito tipos na faixa ODC: a faixa **não** limita evento a escalares. |
| `block-events-two-instances.json` | Duas instâncias do mesmo bloco ligadas por **um só fragmento** da autoria visual (secção 3.5), com `@OnRate` diferente em cada `<Block>`, mais uma terceira criada nativamente a **remapear** os nomes. É a diferença entre ligar por **nome** e ligar por **expressão**. |
| `block-events-nested.json` | Bloco dentro de bloco propagando para cima, na faixa ODC. |
| `block-events-mandatory.json` | Paridade confirmada: obrigatório sem handler também é **erro do Verify** no ODC, também por instância. |
| `tests/jobs-odc-negative/delete-block-event-in-use.json` | A recusa do delete no ODC, com o handler vindo da autoria visual. |

Arquivo de apoio: `tests/html/visual/block-event-two.html` (dois `<Block>` do mesmo bloco, handlers diferentes).

---

## O que se descobriu (as respostas às perguntas do brief)

### 1. Evento obrigatório sem handler: **erro do Verify, não recusa do kernel, não aviso**

É a pergunta que mais enganava. As três hipóteses eram plausíveis; a resposta é a terceira, e ela tem duas
partes que importam separadamente:

* O **kernel não recusa**: `ok=True`, os ops todos aplicam, nenhuma mensagem de `refused`. Quem olhar só para
  o resultado do apply acha que correu bem.
* O **Verify dá erro**, não warning, e o módulo fica inválido (`isValid=False`). Como é erro e não aviso, a
  regra 7 do plano continua a valer: só passa declarado, e só porque a mensagem **é** a prova.

Além disso, **a obrigatoriedade cobra-se por instância**, não por bloco nem por evento: duas instâncias sem
handler dão **duas** mensagens, com caminhos diferentes. E a instância que **já existia** com handler não é
afetada — casa com o que a linha do guia já dizia sobre `IsMandatory` só cobrar instâncias novas.

```
python scripts/run_job.py tests/jobs/block-events-mandatory-reactive.json

== block-events-mandatory-reactive.json: ok=True {'ops': 12, 'objects': 11287, 'isValid': False, 'messages': 2, 'applyMs': 280}
   validation {'new': 2, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
    Error EventHandlerRequiredAction: Required Property Value | OnRate event handler must be set. @ MainFlow (MobileFlow) / RatingDemo (MobileScreen) / MobileBlockInstanceWidget / MainContent (PlaceholderContentWidget) / RatingPicker2 (MobileBlockInstanceWidget) / EventHandler
    Error EventHandlerRequiredAction: Required Property Value | OnRate event handler must be set. @ MainFlow (MobileFlow) / RatingDemo (MobileScreen) / MobileBlockInstanceWidget / MainContent (PlaceholderContentWidget) / RatingPicker3 (MobileBlockInstanceWidget) / EventHandler
    Hint EventHandlerRequiredAction: Definir o Handler do evento obrigatorio, ou tornar o evento do Block opcional (Is Mandatory=No).
```

O ODC responde igual — paridade, não diferença:

```
python scripts/run_job.py tests/jobs-odc/block-events-mandatory.json --lane odc

== block-events-mandatory.json: ok=True {'ops': 33, 'objects': 59373, 'isValid': False, 'messages': 57, 'applyMs': 668}
   validation {'new': 2, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
    Error EventHandlerRequiredAction: Required Property Value | OnPing event handler must be set. @ MainFlow (MobileFlow) / WfPingDemo (MobileScreen) / MobileBlockInstanceWidget / MainContent (PlaceholderContentWidget) / WfPingPanel1 (MobileBlockInstanceWidget) / EventHandler
    Error EventHandlerRequiredAction: Required Property Value | OnPing event handler must be set. @ MainFlow (MobileFlow) / WfPingDemo (MobileScreen) / MobileBlockInstanceWidget / MainContent (PlaceholderContentWidget) / WfPingPanel2 (MobileBlockInstanceWidget) / EventHandler
```

### 2. O `IEventHandler` nasce com a instância, mesmo vazio — e já conta como consumidor

Achado colateral do item anterior, e é o que explica o comportamento do `delete`. Criar a instância do bloco
cria o objeto `IEventHandler` com o `Event` preenchido e **sem** `Handler` e **sem** `Arguments`:

```
   get IMobileBlockInstanceWidget RatingPicker2 {..., "Name": "RatingPicker2", "Arguments": 1, "EventHandlers": 1, ...}
   get IEventHandler  {..., "Event": "@18FhV4_dM0utN4XjIaFYuA"}      <- sem Handler, sem Arguments
```

Consequência prática: o `usages` do evento passa de 2 para **4** só por nascerem duas instâncias vazias, e o
`delete` do evento é recusado **mesmo quando ninguém ligou handler nenhum**. Quem contar "consumidores reais"
pelo número de handlers ligados erra.

```
   usages {"target": "IBlockEvent 'OnRate'", "count": 2, "real": 2, "byType": {"IEventHandler": 1, "ITriggerNode": 1}, ...}   <- antes
   usages {"target": "IBlockEvent 'OnRate'", "count": 4, "real": 4, "byType": {"IEventHandler": 3, "ITriggerNode": 1}, ...}   <- depois de duas instancias VAZIAS
```

`IsMandatory` só aparece no `get` quando é `True`; quando é `False` a chave é omitida.

### 3. Duas instâncias do mesmo bloco: escopo do argumento é **somado**, não exclusivo

A linha do guia diz que as expressões de argumento correm no escopo do evento. Correm — mas **não só**: a
mesma expressão vê os parâmetros do evento **e** as variáveis da tela. `Comment + " / " + LastComment` passa
com `isValid=True` e zero mensagens, onde `Comment` é parâmetro do evento e `LastComment` é variável local da
tela. Quem assumir que o escopo do evento *substitui* o da tela escreve código a mais para nada.

Também fica provado que o handler **não** precisa dos nomes do contrato: `Rating` do evento entra num input
chamado `Score`, e `Rating * 10` mostra que o argumento é expressão, não ligação por nome.

```
python scripts/run_job.py tests/jobs/block-events-two-instances-reactive.json

== block-events-two-instances-reactive.json: ok=True {'ops': 38, 'objects': 11312, 'isValid': True, 'messages': 0, 'applyMs': 328}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IEventHandler  {..., "Event": "@TuYzTknyNU+VX+WycftjKw", "Handler": "@hej8ymeSBk+XSSEGLiSYgA", "Arguments": 2}
   get IEventHandler  {..., "Event": "@TuYzTknyNU+VX+WycftjKw", "Handler": "@afvOJxA09UqUTyYFHftHAw", "Arguments": 2}
   usages {"target": "IBlockEvent 'OnRate'", "count": 3, "real": 3, "byType": {"IEventHandler": 2, "ITriggerNode": 1}, ...}
   usages {"target": "IScreenAction 'RatingPicker1_OnRate'", "count": 1, "real": 1, "byType": {"IEventHandler": 1}, ...}
   usages {"target": "IScreenAction 'RatingPicker2_OnRate'", "count": 1, "real": 1, "byType": {"IEventHandler": 1}, ...}
```

O mesmo `Event`, dois `Handler` diferentes, um consumidor por handler. Note que o bloco continua com **um**
`ITriggerNode`: duas instâncias não duplicam o disparo.

### 4. Tipos compostos no contrato: lista e registo passam, e nem no ODC há limite

Oito parâmetros num só evento, incluindo `CartLine List` e `CartLine`, atravessam do `ITriggerNode` ao
`IEventHandler` com os mesmos tipos. Detalhe que poupa uma tentativa falhada: uma **lista de estrutura** que
chega pelo evento lê-se `LastLines.Current.Qty` — **sem** o nível intermediário que o aggregate exige
(`GetX.List.Current.Entidade.Attr`).

```
python scripts/run_job.py tests/jobs/block-events-types-reactive.json

== block-events-types-reactive.json: ok=True {'ops': 162, 'objects': 11402, 'isValid': True, 'messages': 0, 'applyMs': 453}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IBlockEvent OnCheckout {..., "Name": "OnCheckout", "InputParameters": 8}
   get ITriggerNode RaiseOnCheckout {..., "Event": "@bHf7wrR68UugWVGBWZ6BRg", "Name": "RaiseOnCheckout", "Arguments": 8}
   get IEventHandler  {..., "Event": "@bHf7wrR68UugWVGBWZ6BRg", "Handler": "@fpa4y7ynQESI4wlXgIt5gg", "Arguments": 8}
```

```
python scripts/run_job.py tests/jobs-odc/block-events-types.json --lane odc

== block-events-types.json: ok=True {'ops': 162, 'objects': 59603, 'isValid': True, 'messages': 55, 'applyMs': 1706}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   get IBlockEvent OnCheckout {..., "InputParameters": 8}
   get ITriggerNode RaiseOnCheckout {..., "Arguments": 8}
```

### 5. Bloco dentro de bloco: a propagação lê-se nos `usages`, sem abrir o Studio

O consumidor de um evento de bloco **não precisa de ser uma tela**. `ColorPanel` instancia `ColorPicker`
dentro de si, e o handler dessa instância é uma `IScreenAction` do próprio bloco, que reembala e dispara o
evento de cima. Os dois caminhos dizem tudo — repare que no primeiro não há nenhum `IMobileScreen`, e que no
segundo o `ITriggerNode` está **dentro** do handler do evento de baixo:

```
python scripts/run_job.py tests/jobs/block-events-nested-reactive.json

== block-events-nested-reactive.json: ok=True {'ops': 85, 'objects': 11280, 'isValid': True, 'messages': 0, 'applyMs': 258}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   usages {"target": "IBlockEvent 'OnPick'", "count": 2, "real": 2, "byType": {"ITriggerNode": 1, "IEventHandler": 1}, "entries": [
     {"type": "ITriggerNode",  "path": "IMobileFlow:MainFlow/IMobileBlock:ColorPicker/IScreenAction:Pick/ITriggerNode:RaiseOnPick"},
     {"type": "IEventHandler", "path": "IMobileFlow:MainFlow/IMobileBlock:ColorPanel/IMobileBlockInstanceWidget:ColorPicker1/IEventHandler"}]}
   usages {"target": "IBlockEvent 'OnPicked'", "count": 2, "real": 2, "byType": {"IEventHandler": 1, "ITriggerNode": 1}, "entries": [
     {"type": "IEventHandler", "path": "IMobileFlow:MainFlow/IMobileScreen:ColorDemo/.../IMobileBlockInstanceWidget:ColorPanel1/IEventHandler"},
     {"type": "ITriggerNode",  "path": "IMobileFlow:MainFlow/IMobileBlock:ColorPanel/IScreenAction:ColorPicker1_OnPick/ITriggerNode:RaiseOnPicked"}]}
   usages {"target": "IMobileBlock 'ColorPicker'", "count": 1, "real": 1, "byType": {"IMobileBlockInstanceWidget": 1}, "entries": [
     {"type": "IMobileBlockInstanceWidget", "name": "ColorPicker1", "path": "IMobileFlow:MainFlow/IMobileBlock:ColorPanel/IMobileBlockInstanceWidget:ColorPicker1"}]}
```

(As entradas acima estão abreviadas nos campos `key`/`text`/`derived` para caber; o resto é literal.)

### 6. Apagar o evento: a recusa, e a ordem que a faz passar

A recusa nomeia cada consumidor pelo caminho, e conta a instância **sem** handler como qualquer outra:

```
python scripts/run_job.py tests/jobs-negative/delete-block-event-in-use.json

== delete-block-event-in-use.json: ok=False op #3 (delete ): InvalidOperationException: delete: refused, IBlockEvent 'OnRate' is used by 3 consumer(s): IMobileFlow:MainFlow/IMobileScreen:RatingDemo/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IMobileBlockInstanceWidget:RatingPicker1/IEventHandler; IMobileFlow:MainFlow/IMobileBlock:RatingPicker/IScreenAction:Rate/ITriggerNode:RaiseOnRate; IMobileFlow:MainFlow/IMobileScreen:RatingDemo/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IMobileBlockInstanceWidget:RatingPicker2/IEventHandler (list them with usages, fix or remove those usages, or pass "force": true to break them)
```

O caminho limpo tem **quatro** passos, e o quarto é o que ninguém lembra:

1. apagar o `IEventHandler` da instância **sozinho** — a instância do bloco fica de pé e só perde a ligação;
2. religar o predecessor ao End **antes** de tirar o `ITriggerNode` (nó no meio de fluxo: o conector de
   entrada conta como consumidor);
3. apagar o `IBlockEvent`, já sem `force`;
4. apagar a screen action que era handler. **Apagar o evento não a leva junto.** Sem este passo o Verify
   devolve `Warning UnusedAction: 'RatingPicker1_OnRate' action is never used in RatingDemo`. Isso apareceu
   na primeira versão do job e foi **consertado**, não declarado.

```
python scripts/run_job.py tests/jobs/block-events-delete-reactive.json

== block-events-delete-reactive.json: ok=True {'ops': 13, 'objects': 11251, 'isValid': True, 'messages': 0, 'applyMs': 379}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   usages {"target": "IBlockEvent 'OnRate'", "count": 2, "real": 2, "byType": {"IEventHandler": 1, "ITriggerNode": 1}, ...}
   usages {"target": "IBlockEvent 'OnRate'", "count": 1, "real": 1, "byType": {"ITriggerNode": 1}, ...}
   usages {"target": "IBlockEvent 'OnRate'", "count": 0, "real": 0, "byType": {}, "entries": []}
   usages {"target": "IScreenAction 'RatingPicker1_OnRate'", "count": 0, "real": 0, "byType": {}, "entries": []}
```

### 7. Autoria visual (secção 3.5): liga por **nome**; o `set` nativo liga por **expressão**

Esta é a descoberta com mais consequência prática na faixa ODC, e as duas formas cabem no mesmo job.

* No fragmento, `<Block name="WfRatingPicker" @OnRate="WfStayRated">` liga cada parâmetro do evento ao input
  **de mesmo nome** do handler. Logo, dois handlers diferentes para duas instâncias: **sim**, cada `<Block>`
  com o seu `@OnRate`. Handler com nomes diferentes dos do contrato: **não** — a forma visual não expressa
  remapeamento nem transformação.
* Nativamente, `set $inst/OnRate/<Param> Value <expressao>` aceita qualquer expressão: `Rating * 10` para um
  input chamado `Score`, e `Comment + " / " + StayComment` a misturar evento com tela.

```
python scripts/run_job.py tests/jobs-odc/block-events-two-instances.json --lane odc

== block-events-two-instances.json: ok=True {'ops': 122, 'objects': 59585, 'isValid': True, 'messages': 55, 'applyMs': 1524}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   usages {"target": "IBlockEvent 'OnRate'", "count": 4, "real": 4, "byType": {"ITriggerNode": 1, "IEventHandler": 3}, ...}
   usages {"target": "IScreenAction 'WfStayRated'", "count": 1, ... "path": ".../IContainer:RatingBoard/IContent:content/IMobileBlockInstanceWidget:StayPicker/IEventHandler"}
   usages {"target": "IScreenAction 'WfCleaningRated'", "count": 1, ... "path": ".../IContainer:RatingBoard/IContent:content/IMobileBlockInstanceWidget:CleaningPicker/IEventHandler"}
   usages {"target": "IScreenAction 'WfRemapRated'", "count": 1, ... "path": ".../IMobileBlockInstanceWidget:WfRemapPicker/IEventHandler"}
```

E a recusa do delete é idêntica venha o handler do fragmento ou do `set`:

```
python scripts/run_job.py tests/jobs-odc-negative/delete-block-event-in-use.json --lane odc

  "error": "op #61 (delete ): InvalidOperationException: delete: refused, IBlockEvent 'OnRate' is used by 2 consumer(s): IMobileFlow:MainFlow/IMobileBlock:WfRatingPicker/IScreenAction:Rate/ITriggerNode:RaiseOnRate; IMobileFlow:MainFlow/IMobileScreen:WfRatingDemo/IMobileBlockInstanceWidget/IPlaceholderContentWidget:MainContent/IContainer:RatingPanel/IContent:content/IMobileBlockInstanceWidget:RatingPicker1/IEventHandler (list them with usages, fix or remove those usages, or pass \"force\": true to break them)",
```

Detalhe do caminho que custou uma tentativa: o `**` procura em **largura**. Num `MainContent` que tem a
instância nativa como filha direta e as do fragmento três níveis abaixo, `**IMobileBlockInstanceWidget[1]`
devolve a **nativa**. Para chegar às do fragmento, ancore no contêiner do fragmento primeiro
(`.../MainContent/RatingBoard/**IEventHandler[1]`).

### 8. Faixa ODC também aceita bloco dentro de bloco

```
python scripts/run_job.py tests/jobs-odc/block-events-nested.json --lane odc

== block-events-nested.json: ok=True {'ops': 85, 'objects': 59433, 'isValid': True, 'messages': 55, 'applyMs': 763}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

---

## Suite

```
dotnet test tests/Anvil.Tests --filter "FullyQualifiedName~NegativeJobTests"
Aprovado!  – Com falha: 0, Aprovado: 11, Ignorado: 0, Total: 11

dotnet test tests/Anvil.Tests.Odc --filter "FullyQualifiedName~JobFailsWithTheTeachingMessageInTheOdcLane"
Aprovado!  – Com falha: 0, Aprovado: 3, Ignorado: 0, Total: 3

dotnet test tests/Anvil.Tests --filter "FullyQualifiedName~GuideTests"
Com falha! – Com falha: 1, Aprovado: 12, Ignorado: 0, Total: 13
[xUnit.net] Anvil.Tests.GuideTests.EveryTestJobIsMentionedInTheGuide [FAIL]
```

O único vermelho é o esperado pela regra 4 do plano: os cinco jobs novos de `tests/jobs` ainda não estão
citados no `AGENTS.md`, que eu não edito. Fica verde com a linha abaixo. Nenhum C# foi tocado.

---

## Linha para o `AGENTS.md` (o integrador acrescenta)

Substituir a linha "Evento de bloco" da tabela da secção 1 por esta (acrescenta o que é novo e mantém
inteiro o que já lá estava):

```
| Evento de bloco | O bloco fala com quem o instancia: `IBlockEvent` no bloco (um `IInputParameter` por parametro, `IsMandatory`), `ITriggerNode` numa screen action do bloco para disparar (`set $trg Event $ev`, argumentos em `$trg/<Param>`), e na tela `set $b/<Evento> Handler $acao` mais `set $b/<Evento>/<Param> Value` — o argumento e EXPRESSAO, num escopo SOMADO: ve os parametros do evento E as variaveis da tela, e por isso o handler pode ter nomes fora do contrato. Tipos: lista e registo passam (lista de estrutura le-se `Var.Current.<Attr>`, SEM o nivel do aggregate). Mudar o contrato depois quebra **quem dispara**, nao quem consome (`ArgumentRequiredExpression` no ITriggerNode). Duas instancias do mesmo bloco tem handlers independentes, e o bloco continua com UM trigger. O consumidor nao precisa de ser uma tela: um bloco instancia outro e o handler do evento de baixo dispara o de cima. `IsMandatory` sem handler NAO e recusa do kernel nem aviso: e **erro** do Verify (`EventHandlerRequiredAction`), cobrado por INSTANCIA. O `IEventHandler` nasce com a instancia mesmo vazio, logo conta em `usages` e o `delete` do evento e recusado ate sem handler ligado; para apagar: IEventHandler, religar o predecessor e tirar o ITriggerNode, o IBlockEvent, e por fim a screen action que ficou orfa (senao `UnusedAction`) | Blocos Reactive e Mobile | `block-events-reactive.json` (criar e consumir), `block-events-update.json` (mudar o contrato, por `job:`), `block-events-types-reactive.json` (lista, registo, identificador e mais cinco tipos), `block-events-two-instances-reactive.json` (duas instancias, handlers distintos, escopo somado), `block-events-nested-reactive.json` (bloco dentro de bloco), `block-events-mandatory-reactive.json` (obrigatorio sem handler: erro, `expectValid` false), `block-events-delete-reactive.json` (apagar na ordem certa) e `tests/jobs-negative/delete-block-event-in-use.json` (a recusa); na faixa ODC, `tests/jobs-odc/block-events` liga o evento pela autoria visual (que liga por NOME, sem remapear), com `block-events-types`, `block-events-two-instances`, `block-events-nested`, `block-events-mandatory` e `tests/jobs-odc-negative/delete-block-event-in-use` | `usages` do evento: um ITriggerNode e um IEventHandler por instancia; Verify 0 erros |
```

---

## Diferenças de plataforma encontradas

Nenhuma diferença de **comportamento** entre O11 e ODC nos eventos de bloco: contrato, tipos compostos,
obrigatoriedade, propagação e recusa do delete respondem igual nas duas faixas. Isso é resultado, não
ausência de resultado — era uma das coisas que ninguém sabia.

Duas diferenças de **ferramenta**, não de plataforma:

1. **`base: "job:<nome>"` não procura em `tests/jobs-odc`.** Só na pasta do próprio job e em `tests/jobs`.
   Erro colado:

   ```
   "error": "FileNotFoundException: jobs: parte nao encontrada: job:block-events (procurado em C:\\Users\\andre\\Anvil-cov-b\\tests\\jobs-odc-negative\\block-events.json, C:\\Users\\andre\\Anvil-cov-b\\tests\\jobs\\block-events.json)",
   ```

   O que fiz: tornei `tests/jobs-odc-negative/delete-block-event-in-use.json` autossuficiente sobre a fixture,
   como já faz o `delete-logic-in-use.json`. Não mexi no kernel (regra 3). Se o integrador quiser, resolver
   isto elimina a duplicação de ops entre os jobs positivos e negativos do ODC.

2. **O `get` da faixa ODC devolve muito mais campos** que o do O11 (`TransactionsManager`, `Generation`,
   `Descriptor`, `ReadableIdentifier`, `DisplayName`, `CollectionDescriptor`, `IndexInParent`...). O conteúdo
   útil é o mesmo; só polui a leitura. Não é bloqueio.

## Bloqueios

Nenhum. As duas portas (4627, 4657) estavam livres e nada foi rodado a frio.

Um percalço de ambiente, resolvido sem tocar em nada de ninguém: havia um worker ODC órfão da **primeira**
onda (porta 4557) ainda de pé a partir de `C:\Users\andre\Anvil-cov-b\.local\lane-odc`, segurando
`Anvil.Core.Odc.dll` e fazendo `build_odc.py` falhar com `MSB3027`. Como era processo do meu próprio
worktree e a porta 4557 não pertence a nenhuma frente da segunda onda, parei-o pelo protocolo
(`odc_worker.stop(4557)`) e o build passou. Fica o aviso para quem reusar worktrees entre ondas: `build.py` /
`build_odc.py` só param o worker da porta **corrente**.

Segundo percalço, também resolvido: no primeiro `build.py` num worktree novo, `anvil_cli.LANE.cli` é avaliado
na importação, quando `.local/cli/anvil.dll` ainda não existe, e cai no caminho de fallback
`src/Anvil.Cli/bin/Release/net8.0/anvil.dll`. O build gera o CLI certo mas o arranque do worker falha com
"dotnet-...anvil.dll não existe". Basta correr `build.py` uma segunda vez.

## Fora do brief

* `tests/jobs/block-events-delete-reactive.json` (o caminho limpo do delete). O brief pedia a recusa; a
  recusa sem a receita que a resolve ensina metade. É o mesmo par que a Frente A usou em apagar.
* `tests/jobs-odc/block-events-nested.json` e `tests/jobs-odc/block-events-mandatory.json`. O brief dizia
  "o equivalente do que fizer sentido" na faixa ODC; com estes dois a faixa ODC fica com **paridade completa**
  (5 jobs positivos + 1 negativo em cada faixa), e a pergunta "o ODC cobra obrigatoriedade como o O11?" passa
  a ter resposta em vez de suposição.
* A terceira instância nativa dentro de `tests/jobs-odc/block-events-two-instances.json`, que existe só para
  pôr as duas formas de ligar (nome e expressão) no mesmo job e na mesma tela.

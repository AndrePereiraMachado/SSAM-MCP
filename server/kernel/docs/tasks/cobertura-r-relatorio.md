# Frente R (renomear nas duas faixas) — relatório

**Estado: concluída.**

**Branch/worktree**: `cov2/a` em `C:\Users\andre\Anvil-cov-a`.
**Commits**: `6a3a7d2` (os quatro jobs da faixa O11), `50d2943` (os quatro da faixa ODC), `69df215` (este relatório)
e o que acrescenta estas linhas. Nada fora de `tests/jobs*` e `docs/tasks/`.
**Portas**: `ANVIL_LANE=ss4`, `ANVIL_WORKER_PORT=4617`, `ANVIL_ODC_PORT=4647` — as duas estavam **livres** no início
(`Get-NetTCPConnection -LocalPort 4617`/`4647` sem resultado); as do integrador (4517, 4547) e as das outras frentes
(4627/4657/4667) não foram tocadas. Sessão de comando usada em tudo o que está abaixo:

```powershell
cd C:\Users\andre\Anvil-cov-a
$env:ANVIL_LANE='ss4'; $env:ANVIL_WORKER_PORT='4617'; $env:ANVIL_ODC_PORT='4647'
python scripts\build.py        # worker de pe na porta 4617: pid 5520
python scripts\build_odc.py    # worker odc: de pe, pid 5952
```

---

## O que a frente prova, numa frase

`rename` mantém os consumidores ligados **por chave** e a plataforma regenera o texto do que é modelo; o que é
**texto do autor** (descrição, label posto à mão, literal, CSS, URL escrita à mão, legenda, nome de índice, nome de
aggregate/widget) fica exatamente como estava. E há **uma exceção perigosa na faixa O11**: uma expressão
`<No>.<Saída>` não é reescrita quando a action/o nó/a saída são renomeados — o módulo fica inválido e ninguém avisa
antes do Verify. Na faixa ODC essa mesma expressão é reescrita sozinha.

---

## Jobs entregues

| Job | O que prova |
|---|---|
| `tests/jobs/rename-data-propagation.json` | entidade `Contact`→`Person`, atributo `Email`→`EmailAddress`, variável local `ContactLabel`→`PersonLabel`. Segue: expressões da tela, `Statement` do SQL, `DataType` dos parâmetros, `Entity` do índice, `Label` automático. Não segue: `Description` da entidade e do atributo, `Label` posto à mão, literal `"Contact sem Email"`, nome do índice, nome do aggregate `GetContactById`, nome do `Email_Input`, nome do parâmetro `Contact` |
| `tests/jobs/rename-logic-propagation.json` | `IScript`, client action, server action, screen action, parâmetros de nó JavaScript, variável de tela e **método REST exposto**. Segue: nome do nó consumidor, corpo do JavaScript nos `$parameters.<Nome>`, `URLPath` (inclusive o segmento do nome do método), `Destination`, expressões de variáveis. Não segue: o global `window.Formatting` declarado dentro do script, a legenda do botão, e — **achado** — a expressão `Slugify.Slug` que lê a saída do nó |
| `tests/jobs/rename-interface-propagation.json` | tela, bloco, parâmetro de bloco e variável de tela. Segue: `Destination`, `SourceBlock`, argumentos da instância, nome da própria instância (`ContactCard1`→`PersonCard1`), expressões. Não segue: `StyleSheet` da tela e do bloco, classe CSS na propriedade `Style`, `Description` do bloco, legenda do botão, deep link escrito à mão no `DefaultValue` de uma variável |
| `tests/jobs-negative/rename-name-clash.json` | a **recusa** por colisão de nome, com o texto que ensina a correção |
| `tests/jobs-odc/rename-data-propagation.json` | o primeiro job de rename da faixa ODC: o espelho do de dados, sobre a fixture do WrightFlood |
| `tests/jobs-odc/rename-logic-propagation.json` | o espelho do de lógica; é aqui que a diferença de plataforma aparece lado a lado |
| `tests/jobs-odc/rename-interface-propagation.json` | o espelho do de interface (CSS, classes, URL escrita à mão) |
| `tests/jobs-odc-negative/rename-name-clash.json` | a recusa por colisão na faixa ODC, no runner negativo da faixa (`OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane`) |

Antes destes jobs a faixa ODC tinha **zero** jobs de renomear e a O11 tinha dois (`refactor-usages.json`,
`refactor-contact-reactive.json`), nenhum deles lendo de volta o texto que fica para trás.

---

## Provas

### 1. `tests/jobs/rename-data-propagation.json`

```
> python scripts\run_job.py tests\jobs\rename-data-propagation.json
== rename-data-propagation.json: ok=True {'ops': 56, 'objects': 11367, 'isValid': True, 'messages': 0, 'applyMs': 523}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   data contract: 10 checks, accepted=True
```

Os três renames:

```
rename {"renamed": "IServerEntity 'Person'", "from": "Contact", "to": "Person", "consumers": 19, "expressionsRewritten": 9, ...}
rename {"renamed": "IEntityAttribute 'EmailAddress'", "from": "Email", "to": "EmailAddress", "consumers": 4, "expressionsRewritten": 1, ...}
rename {"renamed": "ILocalVariable 'PersonLabel'", "from": "ContactLabel", "to": "PersonLabel", "consumers": 2, "expressionsRewritten": 2, ...}
```

**O que a plataforma reescreveu** (lido de volta no próprio job, depois do rename):

```
get ISQLNode ReadContacts  ... "Statement": "SELECT {Person}.* FROM {Person} WHERE {Person}.[Email] <> @Empty"
get ISQLNode ReadContacts  ... "Statement": "SELECT {Person}.* FROM {Person} WHERE {Person}.[EmailAddress] <> @Empty"
get EntityIndex IX_Contact_Phone {"Entity": "Person", "Attributes": ["Phone"]}

dump IMobileScreen ContactDetail
     IScreenAggregate GetContactById
       ICombineSourcesOperation Persons
         IAliasedSource Person
         IFilter
           IExpression  = Person.Id = ContactId
       IAddSourceOperation Person
```

**O que ficou para trás** (mesma corrida):

```
get IServerEntity Person ... "Description": "Agenda de contactos. O endereco vive em Contact.Email.", "Label": "Person"
get IEntityAttribute EmailAddress ... "Description": "Email do Contact, mostrado no ecra ContactDetail.", "Label": "Email do Contact"
get EntityIndex IX_Contact_Phone   <- o NOME do indice continua a dizer Contact
get IAssignment ... "Value": "\"Contact sem Email\"", "Variable": "PersonLabel"
get IInputParameter Contact ... "Name": "Contact"        <- o parametro de Contact_Save mantem o nome
```

O `usages` final mostra as duas metades na mesma linha — a expressão reescrita dentro de um widget que não mudou de
nome:

```
usages {"target": "IEntityAttribute 'EmailAddress'", "count": 4, "real": 2, ...
  {"type": "IExpression", "text": "GetContactById.List.Current.Person.EmailAddress",
   "path": ".../IScreenAggregate:GetContactById/... /IForm:ContactForm/.../IInput:Email_Input/CustomProperty:Variable/IExpression"}}
```

Nota: o `Label` da entidade (`Person`/`Persons`) e o do atributo antes de eu pôr um à mão são **automáticos** e
acompanham; o `Label` posto por `set` fica congelado (`"Email do Contact"` acima). São dois comportamentos
diferentes na mesma propriedade.

### 2. `tests/jobs/rename-logic-propagation.json`

```
> python scripts\run_job.py tests\jobs\rename-logic-propagation.json
== rename-logic-propagation.json: ok=True {'ops': 135, 'objects': 11305, 'isValid': True, 'messages': 0, 'applyMs': 223}
   validation {'new': 0, 'fixed': 0, 'preexisting': 0, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

O script renomeado (`Formatting` → `TextHelpers`): o ficheiro publicado muda, o corpo não.

```
get IScript TextHelpers ... "RuntimePath": "/Headless_UI/scripts/Headless_UI.TextHelpers.js",
  "Description": "Helpers de formatacao: window.Formatting",
  "JavaScript": "window.Formatting = { slug: function (s) { ... } };"
```

O corpo do nó JavaScript **é** reescrito nos parâmetros (`Text`→`Term`, `Slug`→`Handle`), e só o global fica:

```
antes:  "JavaScript": "$parameters.Slug   = window.Formatting ? window.Formatting.slug($parameters.Text) : $parameters.Text;"
depois: "JavaScript": "$parameters.Handle = window.Formatting ? window.Formatting.slug($parameters.Term) : $parameters.Term;"
```

**O achado**: renomear a client action `Slugify`→`TextToSlug` renomeia o nó consumidor mas **não** a expressão que
lê a saída dele:

```
get IExecuteClientActionNode TextToSlug ... "Name": "TextToSlug", "Action": "@..."
get IAssignment ... "Value": "Slugify.Slug", "Variable": "Slug"      <- aponta para um nome que ja nao existe
get IAssignment ... "Value": "Slugify.Slug", "Variable": "Slug"      <- e continua depois de renomear a saida
get IAssignment ... "Value": "TextToSlug.SlugText", "Variable": "Slug"  <- so depois do set A MAO do job
```

Sem o conserto à mão o módulo fica inválido. Repro isolado (`.local/probe/probe-rename-breaks-expression.json`:
uma server action com saída `Slug`, uma tela que a chama e guarda `Slug_Make.Slug`, e um `rename` da action):

```
> python scripts\run_job.py .local\probe\probe-rename-breaks-expression.json
== probe-rename-breaks-expression.json: ok=True {'ops': 39, 'objects': 11219, 'isValid': False, 'messages': 1, ...}
 Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Slug_Make' element in expression.
   @ Headless_UI (ESpace) / MainFlow (MobileFlow) / SlugProbe (MobileScreen) / Go (ScreenAction) / Keep (AssignNode) / Assignment
   get IExecuteServerActionNode Slug_Build ... "Name": "Slug_Build"
   get IAssignment ... "Value": "Slug_Make.Slug", "Variable": "Result"
   rename {"renamed": "IServerAction 'Slug_Build'", "from": "Slug_Make", "to": "Slug_Build", "consumers": 1, "expressionsRewritten": 0, ...}
```

Repare no `expressionsRewritten: 0` com `consumers: 1`: o consumidor contado é o **nó**, e a expressão que lê o nó
não entra na conta. Quem confiar no número do `rename` entrega quebrado.

O REST exposto (o caso das URLs) foi ao contrário do esperado — o `URLPath` **acompanha**:

```
get IRestServiceAction SlugOf ... "URLPath": "/SlugOf/{Text}"    <- depois de renomear o metodo GetSlug -> SlugOf
get IRestServiceAction SlugOf ... "URLPath": "/SlugOf/{Term}"    <- depois de renomear o input Text -> Term
get IAssignment ... "Value": "Term", "Variable": "Info.Slug"
```

Ou seja: renomear um método REST exposto **muda sozinho a URL pública do endpoint**, e o Verify não tem como avisar
que os consumidores externos partiram. É o espelho do outro perigo: aqui propaga onde não se queria.

O resto ficou parado, como se espera de texto:

```
get ITextWidget ... "Text": "Slugify o Title"            <- legenda, depois de renomear a action E a variavel Title
get IAssignment ... "Value": "\"Slug_Save guardou: \" + Slug"   <- literal com o nome antigo da propria action
get IExpression ... "Value": "\"Title: \" + SourceText + \" -> \" + Slug"  <- a referencia mudou, o literal nao
```

### 3. `tests/jobs/rename-interface-propagation.json`

```
> python scripts\run_job.py tests\jobs\rename-interface-propagation.json
== rename-interface-propagation.json: ok=True {'ops': 54, 'objects': 11288, 'isValid': True, 'messages': 0, 'applyMs': 261}
   validation {'new': 0, ... 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

CSS e URL, lidos de volta depois dos renames de tela e de bloco:

```
get IMobileBlock PersonCard ... "StyleSheet": ".contact-card { border: 1px solid #ddd; }\n.contact-card__title { font-weight: 700; }",
                                "Description": "Cartao de um Contact, estilizado pela classe contact-card"
get IMobileScreen PersonList ... "StyleSheet": ".contact-list { padding: 16px; }\n.contact-list .contact-card { margin-bottom: 8px; }"
get IContainer CardBody ... "Style": "\"contact-card\""
get IContainer ListBody ... "Style": "\"contact-list\""
get ILocalVariable DetailUrl ... "DefaultValue": "\"/Headless_UI/ContactDetail?ContactId=1\""   <- a tela ja se chama PersonDetail
get ITextWidget ... "Text": "Abrir o Contact"
```

E o que seguiu por chave:

```
get IUILifeCycleEvent OnClick ... "Destination": "@uZ9D5i6C5k+SEgM_yaFrCw", "Arguments": 1
get IMobileBlockInstanceWidget PersonCard1 ... "Name": "PersonCard1", "SourceBlock": "@e6MA39pw40Gvn4w7OLboxw"
get IExpression ... "Value": "\"Contact: \" + Heading"          <- parametro do bloco renomeado, literal parado
get IExpression ... "Value": "\"Link directo: \" + PersonDetailUrl"
```

O nome da **instância** do bloco é derivado: `ContactCard1` virou `PersonCard1` sozinho (o mesmo que acontece com o
nó de uma action). É o oposto do que a intuição diz e vale registrar.

### 4. `tests/jobs-negative/rename-name-clash.json` (a recusa)

```
> python scripts\run_job.py tests\jobs-negative\rename-name-clash.json
== rename-name-clash.json: ok=False op #1 (rename Phone): InvalidOperationException:
   rename: 'Phone' clashes with an existing name in that scope (the Studio would use 'Phone2'); pick another name
```

A mensagem é a prova: ela diz o nome que o Studio usaria em silêncio, que é exatamente o acidente que a recusa
evita. Roda em `NegativeJobTests.JobFailsWithTheTeachingMessage`.

### 5–7. Os três jobs da faixa ODC

```
> python scripts\run_job.py tests\jobs-odc\rename-data-propagation.json --lane odc
== rename-data-propagation.json: ok=True {'ops': 63, 'objects': 59416, 'isValid': True, 'messages': 55, 'applyMs': 854}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
   data contract: 25 checks, accepted=True

> python scripts\run_job.py tests\jobs-odc\rename-logic-propagation.json --lane odc
== rename-logic-propagation.json: ok=True {'ops': 104, 'objects': 59432, 'isValid': True, 'messages': 55, 'applyMs': 551}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True

> python scripts\run_job.py tests\jobs-odc\rename-interface-propagation.json --lane odc
== rename-interface-propagation.json: ok=True {'ops': 53, 'objects': 59481, 'isValid': True, 'messages': 55, 'applyMs': 816}
   validation {'new': 0, 'fixed': 0, 'preexisting': 55, 'unexpected': 0, 'missingExpected': 0, 'ambiguous': 0, 'tolerated': 0} accepted= True
```

As 55 mensagens são as pré-existentes da fixture (`ExpressionComparingDifferentIdentifiers` nas 55 guardas
`GetUserId() = NullIdentifier()` do próprio WrightFlood, já registradas em `2026-09-17-ws1-diferencas.md`):
`new: 0`, `unexpected: 0` nos três.

Dados, ODC (igual ao O11 em tudo):

```
get IServerEntity WfRenAlert ... "Description": "Avisos. O texto vive em WfRenNotice.Body."
get EntityIndex IX_WfRenNotice_Title {"Entity": "WfRenAlert", "Attributes": ["Title"]}
get ISQLNode ReadNotices ... "Statement": "SELECT {WfRenAlert}.* FROM {WfRenAlert} WHERE {WfRenAlert}.[Body] <> @Empty"
get ISQLNode ReadNotices ... "Statement": "SELECT {WfRenAlert}.* FROM {WfRenAlert} WHERE {WfRenAlert}.[Message] <> @Empty"
get IEntityAttribute Message ... "Description": "Corpo do WfRenNotice, ...", "Label": "Body do Notice"
get IExpression ... "Value": "GetNoticesForList.List.Current.WfRenAlert.Message"
get IAssignment ... "Value": "\"WfRenNotice sem Body\"", "Variable": "AlertLabel"
```

Interface, ODC (igual ao O11):

```
get IMobileBlock WfRenNoticeCard ... "StyleSheet": ".wfren-card { ... }", "Description": "Cartao do WfRenCard, ..."
get IMobileScreen WfRenNoticeList ... "StyleSheet": ".wfren-list { padding: 16px; } ..."
get IContainer CardBody ... "Style": "\"wfren-card\""
get ILocalVariable DetailUrl ... "DefaultValue": "\"/WrightFlood/WfRenDetail?NoticeId=1\""
get ITextWidget ... "Text": "Abrir o WfRenDetail"
get IMobileBlockInstanceWidget WfRenNoticeCard1 ... "SourceBlock": "@fWA5EV9z3USpLCpbwDwt7A"
```

### 8. `tests/jobs-odc-negative/rename-name-clash.json`

```
> python scripts\run_job.py tests\jobs-odc-negative\rename-name-clash.json --lane odc
"error": "op #2 (rename Title): InvalidOperationException: rename: 'Title' clashes with an existing name in that
          scope (the Studio would use 'Title2'); pick another name"
```

Mesmo texto nas duas faixas. Roda em `OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane`.

---

## Linha para o `AGENTS.md` (o integrador acrescenta)

Um parágrafo novo na **seção 2**, logo a seguir a **"Apagar com consumidores (op `delete`)"**, no mesmo formato dos
dois que já estão lá. Sem isto o `GuideTests.EveryTestJobIsMentionedInTheGuide` fica vermelho por causa dos três
jobs novos de `tests/jobs`:

> **Renomear (op `rename`).** `rename` recusa colisão de nome no mesmo escopo (`rename: 'X' clashes with an existing
> name in that scope (the Studio would use 'X2'); pick another name`) e devolve `consumers` e `expressionsRewritten`.
> Os consumidores ficam ligados por CHAVE e a plataforma regenera o texto do que é modelo: expressões que citam
> entidade, atributo, parâmetro ou variável; o `Statement` do SQL (`{Entidade}.[Atributo]`); o corpo de um
> `IJavaScriptNode` nos `$parameters.<Nome>`; o `URLPath` de um método REST exposto — **inclusive o segmento com o
> nome do método, ou seja, a URL pública do endpoint muda sozinha**; o nome do nó consumidor de uma action e o nome
> da instância de um bloco; `Destination`, `SourceBlock`, argumentos e os `Label` automáticos. NÃO acompanha nada
> disto, e é preciso corrigir à mão: `Description`, `Label` escrito por `set`, literais de texto dentro de
> expressões, nome de índice, nomes de aggregate/widget/parâmetro que citem o nome antigo, o `StyleSheet` da tela e
> do bloco, a classe CSS na propriedade `Style`, legendas de botão e URLs escritas à mão.
> **Diferença de plataforma:** na faixa O11 uma expressão `<No>.<Saída>` NÃO é reescrita quando a action, o nó ou a
> saída são renomeados (o módulo fica com `ExpressionUnknownObject` e o `expressionsRewritten` do `rename` vem 0);
> na faixa ODC a mesma expressão é reescrita sozinha. Depois de renomear uma action, LEIA de volta as expressões que
> citam o nó (`get`/`dump`). Provas: `rename-data-propagation.json` (entidade, atributo, variável, índice, SQL),
> `rename-logic-propagation.json` (script, client/server/screen action, parâmetros de JavaScript, REST exposto),
> `rename-interface-propagation.json` (tela, bloco, parâmetro de bloco, CSS e deep link) e a recusa em
> `tests/jobs-negative/rename-name-clash.json`; na faixa ODC, `tests/jobs-odc/rename-data-propagation.json`,
> `tests/jobs-odc/rename-logic-propagation.json`, `tests/jobs-odc/rename-interface-propagation.json` e
> `tests/jobs-odc-negative/rename-name-clash.json`.

Opcional, na tabela da seção 1, linha **Refatorar**, coluna "Copie de": acrescentar
`rename-data-propagation.json`, `rename-logic-propagation.json`, `rename-interface-propagation.json` à lista
existente.

---

## Diferenças de plataforma encontradas

### A. O11 não reescreve `<No>.<Saída>` depois do rename; o ODC reescreve

O mesmo job (server action com saída, tela que a chama e guarda `<No>.Slug`, `rename` da action), um em cada faixa
sobre a fixture da própria faixa:

```
> python scripts\run_job.py .local\probe\probe-rename-breaks-expression.json            # O11, reactive-ui.oml
== probe-rename-breaks-expression.json: ok=True {'ops': 39, 'objects': 11219, 'isValid': False, 'messages': 1, ...}
 Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Slug_Make' element in expression.
   @ Headless_UI (ESpace) / MainFlow (MobileFlow) / SlugProbe (MobileScreen) / Go (ScreenAction) / Keep (AssignNode) / Assignment
   get IAssignment ... "Value": "Slug_Make.Slug", "Variable": "Result"

> python scripts\run_job.py .local\probe\probe-rename-breaks-expression-odc.json --lane odc   # ODC, wrightflood-personal-r8.oml
== probe-rename-breaks-expression-odc.json: ok=True {'ops': 39, 'objects': 59367, 'isValid': True, 'messages': 55, ...}
   get IExecuteServerActionNode WfP_Slug_Build ... "Name": "WfP_Slug_Build"
   get IAssignment ... "Value": "WfP_Slug_Build.Slug", "Variable": "Result"
```

Nas duas faixas o **nó** é renomeado pela plataforma e o `rename` devolve `expressionsRewritten: 0`. A diferença
está no que acontece com a expressão: o ODC religa, o O11 deixa o nome antigo e o Verify acusa. Está pinado nos
jobs `rename-logic-propagation.json` das duas faixas: o da O11 tem o `set` de conserto à mão (e o `get` antes dele
mostrando `Slugify.Slug`), o do ODC não precisa e o `_why` diz por quê.

Não é bug do kernel: o `Rename` do `Verbs.cs` só reescreve os referers diretos do objeto renomeado, e a expressão
não é referer da action — é referer do nó. Quem faz (ou não faz) a cascata é a plataforma.

### B. O `URLPath` de REST exposto acompanha — igual nas duas faixas

Sondado nas duas (o job do O11 é `rename-logic-propagation.json`; no ODC ficou em
`.local/probe/probe-rest-odc.json`, porque "REST exposto na faixa ODC" é entrega da **frente T** e não quis pisar
nela):

```
ODC:  get IRestServiceAction GetSlug ... "URLPath": "/GetSlug/{Text}"
      get IRestServiceAction SlugOf  ... "URLPath": "/SlugOf/{Text}"     <- depois de renomear o metodo
      get IRestServiceAction SlugOf  ... "URLPath": "/SlugOf/{Term}"     <- depois de renomear o input
```

Idêntico ao O11. **Não é diferença de plataforma, é um comportamento comum que ninguém tinha escrito.** Se a frente T
criar o job de REST exposto do ODC, o rename entra nele em cinco ops.

### C. Não encontrei diferença nenhuma em dados nem em interface

Descrição, `Label` posto à mão, literais, nome de índice, `StyleSheet` de tela/bloco, classe CSS e deep link ficam
parados nas duas faixas; expressões, `Statement` de SQL, `Entity` do índice, `Destination`, `SourceBlock`,
argumentos e nomes de instância acompanham nas duas. O `EntityIndex` (tipo nativo, ausente do Model API V1)
funciona na faixa ODC exatamente como na O11 — não havia prova disso.

---

## Bloqueios

Em `C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r\BLOCKER.md`, com erro colado e repro:

1. **O `dataContract` guarda os atributos de um `EntityIndex` pelo NOME** (`DataAssertions.RememberCreate`) e nada
   os atualiza no `rename`. Um job que cria um índice e depois renomeia um atributo desse índice sai com
   `accepted=False` **apesar de `isValid=True`, `unexpected=0` e do índice estar correto no modelo**
   (`data mismatch ... 'property': 'Attributes', 'expected': ['Body'], 'actual': ['Message']`). Correção é no
   kernel (regra 3). Contorno nos jobs: o índice cobre um atributo que o job não renomeia, o que ainda prova que a
   `Entity` do índice acompanha e que o nome dele não.
2. **`set` de `StyleSheet` num tema é aceito e descartado**: o op devolve `{"set":"StyleSheet","via":"property"}`,
   o `get` seguinte devolve o texto antigo, e depois de salvar e recarregar o OML o texto novo continua ausente.
   O caminho do op `html` (`HtmlDelta.InstallStylesheet`) funciona e tem teste. Enquanto isto não for resolvido, o
   CSS do **tema** não se corrige por verbo — e um job que "conserta o CSS do tema" com `set` passa verde sem
   consertar nada. Por isso as provas de CSS desta frente usam o `StyleSheet` da própria tela e do próprio bloco.

Nenhum bloqueio de porta: 4617 e 4647 estavam livres.

---

## Fora do brief

- **Método REST exposto** (`IRestService`/`IRestServiceAction`) entrou no `rename-logic-propagation.json` da faixa
  O11 porque "URLs" é uma das quatro categorias do brief e a URL pública de um endpoint é a URL que mais importa
  num módulo. O resultado contrariou a expectativa (acompanha) e virou achado.
- **`IScript` + `IJavaScriptNode`**: o brief pedia "action", mas o corpo em JavaScript é o outro lugar onde texto e
  modelo se misturam. Provou-se que `$parameters.<Nome>` acompanha e o `window.<Global>` não.
- **Sonda do REST exposto na faixa ODC** sem criar job, para não duplicar a entrega da frente T.
- Os jobs desta frente **consertam à mão** o que o rename deixou quebrado (com `get` antes e depois do conserto),
  em vez de pararem no estado inválido: assim a lição fica completa e a suíte continua verde.

## O que o integrador precisa de saber para mesclar

- Os três jobs de `tests/jobs` **precisam da linha do `AGENTS.md`** acima; até lá,
  `GuideTests.EveryTestJobIsMentionedInTheGuide` fica vermelho (é a regra 4 do plano, não uma regressão). Estado
  medido agora, com os 13 testes do `GuideTests`:

  ```
  > dotnet test tests\Anvil.Tests -c Release --filter "FullyQualifiedName~GuideTests"
  [xUnit.net] Anvil.Tests.GuideTests.EveryTestJobIsMentionedInTheGuide [FAIL]
    jobs sem referencia no AGENTS.md (uma LLM fria nao os encontra):
    rename-data-propagation, rename-interface-propagation, rename-logic-propagation
  Com falha!  Com falha: 1, Aprovado: 12, Ignorado: 0, Total: 13
  ```

  Os outros doze passam, incluindo `EveryJobHasAValidMessageContract`, `NoJobPointsAtMutableOml` e
  `NoJobIsAVersionedCopy` — ou seja, os oito jobs novos satisfazem as regras 5, 6 e 7 do plano.
- Nenhum arquivo de `src/`, `tests/Anvil.Tests*`, `AGENTS.md`, `CLAUDE.md` ou `*.csproj` foi tocado. Só entraram
  jobs novos e este relatório.
- Os oito jobs entram sozinhos nos runners que já existem: `JobTests` (`tests/jobs`), `NegativeJobTests`
  (`tests/jobs-negative`), `OdcJobTests.JobAppliesAndVerifies` (`tests/jobs-odc`) e
  `OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane` (`tests/jobs-odc-negative`).

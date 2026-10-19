# Autoria visual em HTML (op `html` com `parent`)

Um fragmento de HTML vira widgets nativos dentro de um pai que **ja existe**, e nada mais. Logica e nativa: veja specs
`logic`. O fragmento nao cria variaveis, actions, aggregates, data actions nem eventos; ele **liga pelo nome** ao que o
modulo ja tem. Um nome que nao existe e erro **antes** do primeiro op, com linha, coluna, o nome que faltou e a lista dos
que existem.

Isto e a metade *visual* da autoria HTML. A op `html` com `data` (seccao 3.5 do `AGENTS.md`) compila uma **pagina
inteira** com o seu manifesto tipado (dados, filtros, eventos, client functions). As duas convivem: a forma com `parent`
e escolhida quando o op traz `parent`.

```json
{"op": "html", "parent": "$tela/#IMobileBlockInstanceWidget/MainContent", "file": "tests/html/visual/alert.html"}
```

| Chave | Contrato |
|---|---|
| `parent` | o widget que recebe o fragmento: `$alias`, `@<ObjectKey>` ou `Tipo:Nome`; tem de estar dentro de uma tela ou bloco Reactive/Mobile. Se for a propria tela, o fragmento vai para o placeholder de conteudo do layout (`MainContent`, senao `Content`); o relatorio traz `parent` resolvido e `parentAuthored`. Layout sem placeholder de conteudo: recusa com os caminhos exatos dos placeholders |
| `file` | caminho do `.html`, resolvido a partir da pasta de trabalho e da raiz do repositorio |
| `html` | o fragmento em linha, em vez de `file` |

## A sintaxe, fechada

O que nao esta nesta tabela e erro com linha e coluna. A mesma tabela, legivel por maquina, esta em
`src/Anvil.Core/Kernel/HtmlVisualVocabulary.json` (`HtmlVisual.Schema()`; o teste
`TheVocabularyFileIsExactlyTheCompiledSyntax` prova que as duas nao divergem).

| HTML | Widget | Regra |
|---|---|---|
| `<div>` | `IContainer` | `class` -> Style; `id` -> Name do widget |
| `section, article, header, footer, main, nav, aside, ul, ol, li, h1..h6, p, span, strong, em, small, code, hr` | `IAdvancedHtml` com `Tag` | idem; sem Style nativo, a `class` vai como extended property; o Verify aceita `hr` (Cardápio, 06/10: quatro `<hr>` entregues com 0 erros) |
| `<br>` | `IContainer` vazio | um bloco vazio quebra a linha; o Verify recusa `br` como HTML Element |
| texto literal | `ITextWidget` | sem classe propria: a `class` fica so no elemento em volta (repetir a classe no texto aninhava o estilo, uma pilula dentro da outra); o espaco junto de um elemento inline (`<strong>Ctrl</strong> ao soltar`) e mantido |
| `{{ expressao }}` | `IExpression` | a expressao e OutSystems, copiada tal qual; nao e JavaScript |
| `<i icon="warning-circle" weight="regular">` | `IIcon` | `weight` obrigatorio onde o icone tem Weight (ODC); no O11, sem `weight`, como a leitura escreve |
| `<input bind="Var" placeholder="..." type="text\|password\|number\|time\|date\|datetime-local\|tel\|email\|search">` | `IInput` | `bind` e o nome de uma variavel/atributo existente; `placeholder` -> Prompt; o tipo da variavel ligada decide o InputType (Time -> Time, Date -> Date, Date Time -> Datetime, Integer/Long Integer/Decimal/Currency -> Number, Email -> Email, Phone Number -> Phone, Text -> Text), como o Verify exige; um `type` que o Verify recusaria (`tel` sobre Text) cede ao da variavel e sai em `inputTypes` do relatorio; `password`/`search` sobre Text ficam; Boolean ou Binary Data num `<input>`: `INPUT_TYPE_MISMATCH` (Boolean: use `type="checkbox"`); sem `<label>` automatico |
| `<textarea bind="Var">` | `ITextArea` | |
| `<select bind="Var" options="Lista" value="Id" label="Label">` | `IDropdown` | `options` -> List, `value` -> Values, `label` -> Labels |
| `<input type="checkbox" bind="Var">` | `ICheckbox` | |
| `<button onclick="Acao(arg, ...)" class="btn">Texto</button>` | `IButton` | `Texto` substitui a legenda propria do widget (nunca acrescenta outra); com `{{ expressao }}`, so com `<i>` ou com outros elementos filhos, a legenda nativa e apagada e o conteudo vira widgets na ordem escrita, com o escopo da lista; `onclick` nomeia uma screen action, client action ou **tela** existente (veja "Destino e argumentos"); sem `onclick` o controle fica sem destino (um op seguinte do job pode dar) |
| `<a onclick="Acao">Texto</a>` | `ILink` | idem; `href` com o nome de uma tela tambem navega; `href="#"` nao da destino; `href` com URL fica como atributo; link so com icone: `title` vira tambem `aria-label` |
| `<label for="Id">Texto</label>` | `ILabel` | `for` aponta ao `id` de um input do mesmo fragmento -> `TargetWidget`; com elementos filhos (`Texto <span>*</span>`) vira um `IContainer` com a classe do label, o `ILabel` com o texto proprio e os filhos, na ordem escrita |
| `<ButtonGroup bind="Var"><ButtonGroupItem value="True">Sim</ButtonGroupItem>...</ButtonGroup>` | `IButtonGroup` + `IButtonGroupItem` | a rota nativa: grupo criado vazio com `Variable`, cada item com `Value` e a legenda como `IExpression` (texto entre aspas, `{{ }}` como escrito) |
| `<img src="Imagem">` | `IImage` | `src` e nome de imagem do modulo; `src` com URL (`https://...`) ou `{{ expressao }}` vira `Type External` com `Url` |
| `<div list="GetX.List" as="Row">` | `IList` | dentro, `{{ Row.Atributo }}`; `as` e obrigatorio; `list` vazio e erro: o Source fica no proprio elemento |
| `<div if="expressao">` | `IIfWidget` | ramo True recebe os filhos; `else` como `<div else>` irmao imediato |
| `<Block name="WF_X" :Input="expr" @Evento="Acao">` | `IMobileBlockInstanceWidget` | inputs por `:Nome`, handlers por `@Evento="Acao"` ou, como a leitura escreve, `@Evento="Acao(Input = expr)"` (cada input recebe o valor que a chamada nomeia; posicional e recusado com a forma nomeada; `@Evento.Input="expr"` so ao lado de `@Evento`, sozinho e recusado; o mesmo input dado duas vezes, na chamada e em `@Evento.Input`, e recusado), filhos por `<slot name>` -> placeholder; sem `id`, a instancia nasce sem nome, como o Studio a cria; com `<slot>`, nasce com os placeholders vazios (`empty`), sem o conteudo de exemplo do padrao |
| qualquer outro atributo | `IExtendedProperty` | valor literal; com `{{ }}` (tambem em `class`) vira expressao: `class="chip {{ X }}"` e `"chip " + (X)` |
| `<style>` | CSS do tema | reescrito com prefixo da classe raiz; `@keyframes` e `@font-face` passam inteiros |

Nomes de widget vem de `id` ou sao gerados `Tag1, Tag2` por posicao (`Div1`, `Span2`, `P3`). Nada de `script`.
- O numero gerado pula todo nome que a tela (ou o bloco) ja tem: a base e os ops anteriores do job, inclusive outro fragmento.
  Dois fragmentos na mesma tela nunca dao o mesmo nome (lab 20: "Duplicated object Block1").
- Um `<Block>` sem `id` nao recebe nome: fica como a instancia que o Studio cria (CustomName vazio). O `Block1` gerado era
  descartado pelo merge do Studio (labs 18 a 38: `MERGE_UNCERTAIN`).
- Um `id` que ja e nome de widget da tela e recusado com o nome livre: `HTML_ID_DUPLICATE` quando veio de um fragmento
  anterior do mesmo job, `NAME_COLLISION` quando veio da base ou de outro op.
- Cada `id` vira tambem o alias `$<id>` para os ops seguintes do job (salvo se o job ja usa esse alias); o relatorio lista
  em `aliases`.

`onclick`, `bind`, `@Evento`, `Block name` e `img src` que nao existirem no modulo sao erro antes de emitir ops, com o
nome que faltou e a lista dos existentes.

`</hr>` e `</br>` fechando o elemento vazio sao ignorados, como no navegador, e ditos em `notes` do relatorio.

## Destino e argumentos

`onclick` (ou o `href` de um `<a>`) nomeia uma action ou uma tela do modulo:
- `onclick="CellClick(0)"`: os argumentos vao na ordem dos inputs do callee;
- `onclick="Abrir(Id = Row.Id)"`, como a leitura escreve: cada argumento pelo nome do input. Quando o nome antes do `=` nao e
  input do callee e e uma variavel do escopo (`Filtrar(MostrarTodos = True)`, input `SoAtivos`), e uma comparacao passada
  por posicao, como antes; um nome que nao e nenhum dos dois (erro de digitacao de um input) fica nomeado e e
  `ARGUMENT_UNKNOWN` com os inputs. Sem a assinatura do callee (action criada no mesmo job), vale a forma da leitura;
- `:Index="expr"` no proprio controle: o argumento pelo nome do input;
- os ops saem nesta ordem: `set $hv.N/OnClick Destination`, depois um `set $hv.N/OnClick/<Input> Value` por argumento.

Com a lista explicita (parenteses ou `:Input`), argumento sem input e `ARGUMENT_UNKNOWN` e input obrigatorio que faltou
e `REQUIRED_ARGUMENT`. So com o nome (`onclick="ProdutoDetalhe"`), um input obrigatorio recebe a variavel de mesmo nome
do escopo, como no evento de bloco, e sai em `implicitArguments`; sem essa variavel, fica para um op seguinte do job e
para o Verify.

Todos os problemas de um fragmento saem numa recusa so, no preflight (`HtmlVisual.PreflightOp`) e no apply: um problema
mantem a excecao de sempre com o problema codificado dentro; varios viram `HTML_INVALID` com a lista. Cada elemento da
todos os seus problemas, nao so o primeiro. Codigos: `HTML_TAG_NOT_ALLOWED` (tag fora da tabela, `script`),
`INPUT_TYPE_MISMATCH`, `CSS_FUNCTION_UNSUPPORTED`, `HTML_ID_DUPLICATE`, `NAME_COLLISION`, `ARGUMENT_UNKNOWN`,
`REQUIRED_ARGUMENT` e `HTML_INVALID` (o resto). O ponteiro e relativo ao op (`/html` ou `/file`); a linha e a coluna estao na mensagem.

## Tres exemplos

### 1. Um painel de alerta (`tests/html/visual/alert.html`, job `tests/jobs/html-visual-alert.json`)

```html
<style>
  :root { border: 1px solid #f0b429; border-radius: 6px; padding: 12px; }
  .wf-alert-title { font-weight: 600; }
</style>
<div id="PinAlert" class="wf-alert">
  <div class="wf-alert-head">
    <i icon="exclamation-triangle" weight="regular" class="wf-alert-icon"></i>
    <span class="wf-alert-title">Pin not found</span>
  </div>
  <p class="wf-alert-body">The pin you asked for is not in this report.</p>
  <div class="wf-alert-field">
    <label for="PinInput">Pin</label>
    <input id="PinInput" bind="PinNumber" placeholder="e.g. 1234" type="text" aria-label="Pin">
  </div>
  <button id="RetryButton" onclick="RetrySearch" class="btn btn-primary">Try again</button>
</div>
```

`PinNumber` e uma variavel da tela e `RetrySearch` uma screen action, ambas criadas por verbos antes da op. O fragmento
so as nomeia.

### 2. Uma lista sobre um aggregate (`tests/html/visual/list.html`, job `tests/jobs/html-visual-list.json`)

```html
<div id="UserList" list="GetUsers.List" as="Row" class="wf-list">
  <div class="wf-row">
    <span class="wf-row-name">{{ Row.User.Name }}</span>
    <span class="wf-row-mail">{{ Row.User.Email }}</span>
  </div>
</div>
```

`as="Row"` nomeia o registro corrente: dentro da lista, `Row` e reescrito para `<list>.Current`, portanto
`{{ Row.User.Name }}` vira `GetUsers.List.Current.User.Name`. O aggregate `GetUsers` ja existe na tela.

### 3. Uma instancia de bloco (`tests/html/visual/block.html`, job `tests/jobs/html-visual-block.json`)

```html
<div id="BookingPanel" class="wf-booking">
  <span class="wf-booking-title">Pick a date</span>
  <Block id="BookingDate" name="DatePicker" :DateFormat='"yyyy-MM-dd"' @OnSelected="DateChosen"></Block>
</div>
```

`DateChosen` e uma screen action existente; cada parametro do evento chega ao handler pelo input de mesmo nome
(`DatePickerId`, `SelectedDateTime`), a mesma ligacao que o Studio pede a mao. Blocos com conteudo de exemplo dentro de
um placeholder (DatePicker, Search, InputWithIcon) continuam a precisar do `set` nativo desse conteudo depois da op:
`set $tela/#IMobileBlockInstanceWidget/MainContent/**IMobileBlockInstanceWidget[1]/Datepicker/#IInput Variable ...`.

## CSS

Um `<style>` no fragmento exige exatamente um elemento raiz com `class`: essa classe e o escopo. `:root`, `html`,
`body` e `#reactContainer` viram a propria raiz; um seletor que ja comeca pela classe raiz (`.raiz`, `.raiz .x`,
`.raiz:hover`) fica como esta; os outros seletores sao prefixados por ela. Seletor por id (`#x`) e sempre recusado (o
OutSystems reserva o atributo `id`, Verify `InvalidHTMLAttribute_Id`): selecione por classe. O resultado e instalado no
tema padrao do modulo entre marcadores `/* anvil:html <classe-raiz> */`, substituidos a cada compilacao. Para o ver,
leia o tema pelo result.json e nao pela consola (o `run_job.py` corta a impressao a 1500 caracteres):
`data.results[<i>].result.properties.StyleSheet` de um `{"op":"get","target":"IMobileTheme:<Modulo>"}`.

CSS que o tema nao renderiza (`CssCompat`, nas duas formas do op `html` e num `set StyleSheet` cru):
- `light-dark(a, b)` vira o valor claro na regra e um bloco `@media (prefers-color-scheme: dark)` com o escuro; o relatorio
  traz `css.lightDarkExpanded`;
- `color-mix(...)` e recusado com `CSS_FUNCTION_UNSUPPORTED` e o substituto: a cor calculada quando as duas cores sao literais
  (`in srgb`, `srgb-linear`, `oklab`, ou qualquer espaco com `transparent`); com `var()` ou espaco polar, escreva a cor literal;
- num `set StyleSheet` cru a regra `PreflightRules.StyleSheetRules` da um problema por op e, quando a troca e mecanica, o patch
  RFC 6902 com a folha ja renderizavel.

CSS que o tema renderiza, mas no lugar errado (nunca bloqueia):
- seletor que comeca por `#reactContainer` vira `:is(#reactContainer, body)`: o canvas do Studio nao tem `#reactContainer`
  e os blocos ficavam sem estilo la;
- `@import` depois de uma regra e ignorado pelo navegador; num tema com CSS do Theme Editor, todo `@import` do autor sobe
  para o topo da efetiva, antes do bloco gerado (a metade do autor guarda o texto como foi escrito);
- num tema com CSS do Theme Editor o `set StyleSheet` aplica os dois e o resultado diz em `styleSheet.cssRewrites` e
  `styleSheet.cssImportsHoisted`; num `set` cru a regra da o aviso `CSS_REWRITTEN` com o patch.

## Duas plataformas, uma tabela

O compilador nao conhece plataforma: ele pergunta ao `HtmlVisualScope` se o widget do Studio alvo tem a propriedade
(`Supports`). Sem resposta, vale o vocabulario Reactive/Mobile do proprio kernel (`ScreenVocabulary.json`). Consequencia
visivel hoje: `IIcon` do O11 (Model API 11.55.69) **nao tem** `Weight`, o do ODC tem. O `weight` e pedido onde o icone o
tem (ODC: obrigatorio, sem ele o Studio mostra "Non Existing Icon") e chega ao modelo ali; no O11 a leitura nao escreve
`weight` e o fragmento aceita o `<i>` como a leitura o escreve (ponto fixo); um `weight` escrito no O11 e ignorado. O mesmo mecanismo serve ao `Adapters.ODC`
(WS1) sem tocar nesta tabela.

## Provas

| Prova | Comando |
|---|---|
| A tabela e as recusas, sem Studio | `dotnet test tests/Anvil.Tests -c Release --filter "HtmlVisualTests|Pa3KhHtmlTests|Pa3KhCssTests"` |
| Alerta sobre a fixture Reactive | `python scripts/run_job.py tests/jobs/html-visual-alert.json` |
| Lista sobre um aggregate | `python scripts/run_job.py tests/jobs/html-visual-list.json` |
| Instancia de bloco com input e handler | `python scripts/run_job.py tests/jobs/html-visual-block.json` |

No ODC os mesmos tres jobs correm sobre a fixture ODC em `tests/jobs-odc/` assim que o WS1 fechar.

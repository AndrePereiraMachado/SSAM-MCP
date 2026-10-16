# HTML do SSAM (`ssam-html/1`): a leitura e a edição de telas e blocos

Etapas C1, C2 e B1 do plano "Texto do SSAM" (`C:\Users\andre\SSAM-analises\html-do-ssam\PLANO.md`, seções 1, 2, 3 e
8): a **ida** de tela para HTML (C1), a **volta** (C2) e a **criação** pela forma documento (B1). Uma tela ou bloco de
uma captura vira um documento HTML que carrega a **fonte**, nunca o estado que o runtime mostraria; o modelo devolve só os
elementos que mudou e o SSAM escreve só essa diferença, com as ops nativas, sem limpar nem recriar a tela. A forma
documento compila este mesmo texto (seção "Criar tela (B1)", no fim). O que está ligado no MCP e o que ficou só leitura
está em `docs/TEXTO-SSAM.md`.

Código: `kernel/src/Anvil.Core/Kernel/ScreenHtml.cs` (tabelas, texto, parser, forma canônica) e `ScreenHtmlModule.cs`
(a leitura e o decodificador). O11, ODC e o builder compilam os mesmos arquivos; a leitura passa só por `ModelReader`.
A volta: `ScreenHtmlEdit.cs` (a op, as recusas, o escritor canônico do texto), `ScreenHtmlModule.Edit.cs` (o plano:
junção, checagens, escrita, conferência), `ScreenHtmlMerge.cs` (o merge de 3 vias com a leitura do `basedOn`),
`Verbs.ScreenHtml.cs` (a op `html` na forma edição, dentro do job, pelos verbos) e `ScreenHtmlEditBattery.cs` (as edições
sintéticas do aceite).

## Como ler

- MCP: `ssam_map {lane, target, view:"html"}` lista as telas e blocos; `ssam_map {lane, target, view:"html", screen}` lê um
  (nome, `Tipo:Nome` ou `@key`), em páginas de linhas inteiras; `keys:true` traz a tabela `k -> ObjectKey` na resposta.
- CLI do desenvolvedor: `.\ssam map --lane o11 <captura|Módulo> --html [--screen X] [--keys]`; frias:
  `anvil html-read --oml <captura> [--path <tela>] [--out a.html]`, `anvil html-check --oml <captura>` (ponto fixo de todas
  as telas e blocos, com tamanhos e tempos) e `anvil html-census` (o que as telas contêm, por tipo e propriedade). O mesmo
  em `anvil-odc`.

## A forma

```html
<screen name="Login" actions="LoginOnClick, OnTogglePasswordVisibility" roles="AppRole:FloodQuotes" title='"Log in"' os-AnonymousAccess="True">
<var k="w1" name="UserEmail" type="Text" description="Holds the user email of the login form."/>
<Block k="w5" name="Layout_Blank">
 <slot name="Content">
  <form k="w7" id="LoginForm" class="login-form">
   <input k="w17" id="Input_Username" bind="UserEmail" maxlength="250" required="True" class="form-control"/>
   <a k="w22" onclick="OnTogglePasswordVisibility">
    <div k="w23" id="PasswordVisibile" if="MakePasswordVisible">
     <i k="w24" icon="eye-slash" class="icon"/>
    </div>
    <div else>
     <i k="w25" icon="eye" class="icon"/>
    </div>
   </a>
   <Block k="w31" name="ButtonLoading" :ExtendedClass='"full-width"' :IsLoading="IsExecuting">
    <slot name="Button">
     <button k="w32" class="btn btn-primary" os-IsDefault="True" onclick="LoginOnClick" os-onclick.BuiltInValidations="ValidateAndContinue">Log in</button>
    </slot>
   </Block>
  </form>
 </slot>
</Block>
</screen>
```

| No texto | No modelo |
|---|---|
| `<screen>` / `<block>` com `name`, `title`, `roles`, `description`… | a tela ou o bloco; `actions` e `data-actions` são só os nomes (o corpo fica no texto da lógica) |
| `<input name type>`, `<var>`, `<aggregate>`, `<event>` (bloco) | Input Parameter, Local Variable, Screen Aggregate (com as partes como `os-<Tipo>`), Block Event |
| `div`, `form`, `a`, `button`, `input`, `textarea`, `select`, `radio-group`, `switch`, `button-group`, `label`, `img`, `i`, `popup`, `placeholder`, `upload`, `list-item`, `expr`, `text` | Container, Form, Link, Button, Input/Checkbox, TextArea, Dropdown, RadioGroup, Switch, ButtonGroup, Label, Image, Icon, Popup, Placeholder, Upload, ListItem, Expression, Text |
| `<x list="Fonte">` | List com Tag `x` (tag vazia ou esquisita: `<list tag>`) |
| qualquer outra tag | HTML Element; tag que a linguagem usa para si leva o marcador `html`, tag esquisita vira `<html-element tag>` |
| `<div if="Cond">` … `<div else>` … | If, os dois ramos (o `else` só quando não é vazio) |
| `<Block name=":Nome" :Input="expr" @Evento="Destino(P = expr)">` + `<slot name>` | instância de bloco, argumentos, handlers e o conteúdo de cada placeholder |
| `on<evento>="Destino(P = expr)"` | evento nativo com destino e argumentos; as outras propriedades do evento, `os-on<evento>.<Prop>` |
| `{{ expr }}` numa linha; texto numa linha; `<text>` exato | Expression e Text sem nada mais de seu (os "runs") |
| texto e ligações na mesma linha (`Hoje · {{ X }}`, `{{ N }} dias`) | uma Expression, a concatenação (`"Hoje · " + X`), lida de volta como `{{ "Hoje · " + X }}` |
| `class="a b"` / `class="{{ expr }}"` | Style (ou StyleClasses): literal simples nu, qualquer outra expressão entre `{{ }}` |
| atributo qualquer (`aria-label`, `role`, `data-*`) | extended property, na ordem da lista do widget; nome já usado vira `ext:<nome>` |
| `os-<Propriedade>="valor"` | qualquer propriedade autorada fora da tabela, com o nome do Model API e o valor como está no modelo |
| `<os-opaque k kind name>` | tipo sem linha na tabela: intocável. Tabela (`TableRecords`, `HeaderCell`, `RowCell`) e `MobileWidget` mantêm os widgets das células dentro; Traditional Web (D2) esconde a subárvore inteira |

O que não é fato da página (chaves, contabilidade, posição no canvas, valores derivados) não é escrito; a lista está em
`ScreenHtml.Contract()["notFacts"]`. Propriedade no padrão não é escrita e ausente lê como o padrão
(`Contract()["defaults"]`, medidos no corpus). Nada é descartado em silêncio: o que a leitura não sabe colocar vira
problema do documento e conta contra o ponto fixo.

## Nomes

Uma referência é escrita como o primeiro de `Nome`, `Tipo:Nome`, `Dono.Nome`, `Tipo:Dono.Nome` que volta exatamente ao
mesmo elemento a partir desta tela; senão `@key`. Ordem de procura: a própria tela, o topo do módulo (inclusive as
assinaturas de referências), o resto do módulo fora de telas, as outras telas e, por fim, o que está fora da leitura (tipos
básicos, corpo de actions), que a própria tela cita.

## Chaves e base

`k="w<n>"` é a ordem de visita. A tabela `k -> ObjectKey` (também `""` da raiz, `k.true`/`k.false` dos ramos, `k/slot` dos
slots e `k~n` dos runs) fica em `keysFile`, ao lado do índice da captura, com o sha256 da captura e o do HTML
(`basedOn {capture, html}`). Uma edição baseada nessa leitura acha as chaves por esses dois hashes. O arquivo guarda também o
texto da leitura: é a base do merge de 3 vias quando a tela muda entre a leitura e a entrega.

## Editar (C2)

A correção é **uma chamada**: a op `html` na forma edição, dentro do job da entrega (`o11_deliver` ou `studio_deliver`),
com só os elementos que mudaram, cada um inteiro e com o seu `k`. A resposta da `ssam_map view:"html"` já traz essa chamada
pronta em `continuations.edit`.

```json
{"op":"html","data":{"screen":"FarmaVirtual","basedOn":{"capture":"<sourceSha256>","html":"<htmlSha256>"},
  "edit":["<div k=\"w23\" class=\"header-links\"><div if=\"Client.FvUser = 1\"><a k=\"w24\" ...>...</a></div></div>",
          "<style>.fv-prototype { ... }</style>"]}}
```

| No texto da edição | O que vira |
|---|---|
| atributo, propriedade (`os-*`), expressão, texto de uma linha | `set` só daquela propriedade (a linha de texto mantém a chave) |
| atributo qualquer novo, alterado ou removido | `create` / `set` / `delete` da extended property, na ordem da lista |
| `on<evento>`, `@Evento`, argumentos | `set` do destino e dos `Value` dos argumentos; evento HTML novo ou removido: `create` / `delete` |
| elemento sem `k` | `create` sob o pai, no lugar escrito (o nome e as referências de um widget novo também) |
| filho com `k` que sumiu do elemento enviado | `delete` (recusado antes, com os usos, se algo de fora usa) |
| `k` sob outro pai | `move` (o Model API dá chaves novas à subárvore movida: listadas em `keyChanged`) |
| `k` na mesma posição relativa trocada | `place` (mesmo pai: a chave fica) |
| tag de outro widget no mesmo `k` | `delete` + `create`, listado em `keyChanged` |
| `<div if>` com o seu `<div else>` | uma edição só; os dois ramos |
| `<style>` | a folha de estilo da tela |
| o documento inteiro | aceito, com a mesma regra aplicada à raiz |

Recusas, todas numa resposta, antes de escrever (`HTML_EDIT_INVALID`, `HTML_EDIT_NO_KEY`, `HTML_KEY_FOREIGN`,
`HTML_EDIT_OVERLAP`, `HTML_KEY_TWICE`, `HTML_OPAQUE_TOUCHED`, `HTML_VISIBLE`, `HTML_SCRIPT`, `HTML_FOREACH`, `HTML_JSON`,
`HTML_NAME_UNKNOWN`, `HTML_NAME_TAKEN`, `HTML_DELETE_IN_USE`, `HTML_SLOT_UNKNOWN`, `HTML_ACTIONS_LISTED`, `HTML_DATA_NEW`,
`HTML_KIND_CHANGED`, `HTML_BASE_CHANGED`):

- **Uma recusa só, com todos os problemas** (bloqueio B3 da conferência de 12/10/2026; a rodada do patch da revisão de
  12/10/2026, docs/TEXTO-LOGICA.md: quando a recusa é por uma regra do dono, a edição com o patch aplicado roda numa cópia
  da base e o Verify dos outros elementos dela entra na mesma recusa, `afterPatch: true`, com o ponteiro da op). O preflight sem módulo diz o que dá
  para dizer sem a leitura (`<script>`, e num elemento novo, sem `k`, o `javascript:`, o evento que não é chamada e o
  `v-for`), mas não para a op por isso: o plano da edição roda na mesma recusa, com a leitura, e diz de novo cada regra,
  agora com o `k` e o patch, ao lado de todo o resto. A função desconhecida de uma ligação da edição (`JSONSerialize` no O11)
  vem da checagem da base, na mesma recusa (`FUNCTION_UNKNOWN`), antes do Verify. O mesmo lugar sai uma vez: a mesma regra
  no mesmo elemento (`k`; um elemento novo ou um `<script>`, pela mensagem).
- As regras sobre o que a edição escreve de novo têm patch quando a correção é certa, todas numa **lista de edições
  corrigida só**, a mesma em cada problema que ela corrige. O patch só sai quando planeja sem nenhum problema que a edição já
  não tivesse; se as iterações o impedem (uma fonte que a página não tem), sai sem elas:
  - `os-Visible` novo ou alterado (U1): o elemento dentro de um `<div if>`. O `Visible` que a leitura tinha fica e é listado
    em `visiblePreserved`.
  - `HTML_SCRIPT`: o `<script>` sai; um `javascript:` ou um evento que não é `Destino(...)` volta ao valor que a leitura
    tinha (quando era uma chamada) ou sai. O evento que a leitura já tinha fica. O clique de um `<button>` ou de um `<a>` sem
    nada a pôr de volta não sai: Button e Link exigem o On Click (`RequiredPropertyValue_Property`), então não há patch para
    ele, só a correção escrita (nomear a screen action ou a tela que ele roda); as outras correções da edição vêm no patch.
  - `HTML_FOREACH`: o `v-for` (ou `x-for`, `ng-repeat`...) vira `list="Fonte"` e a linha `Fonte.Current`, como na forma
    documento. O plano lê nomes, não expressões: o patch só sai quando a fonte é dado da página (um aggregate, uma variável
    ou um input da leitura, ou uma saída de uma data action que a página lista em `data-actions`, como `CartCards.Cards`) e
    a linha lê o que esse dado tem (uma lista de valores, inteira; um registro, pelos atributos que o módulo tem; a saída de
    uma data action, pelos membros que o Verify confere). O aggregate de tela, que a leitura escreve na forma longa
    (`os-AliasedSource`), nomeia a sua entidade na linha (`GetPedidos.List.Current.Pedido.Numero`). Senão o problema vem com a
    correção escrita no `fix`, sem patch.
  - `HTML_JSON` (L6) não tem patch: o registro ou a lista vão como são.
- Nome que não resolve: o candidato certo quando há um só (`write 'Refresh'`), senão os 3 mais próximos. O destino de um
  evento procura primeiro como qualquer referência e, se for ambíguo, só entre actions e telas (`onclick="Save"` é a screen
  action mesmo quando há um widget `Save`).
- Input (Input, TextArea, Dropdown, Checkbox, Switch, RadioGroup, ButtonGroup, Upload) novo ou movido para dentro de um link
  ou botão: recusado no plano (a plataforma recusaria no `create`).
- Screen actions, aggregates e data actions não são criados pela página (`HTML_DATA_NEW`, `HTML_ACTIONS_LISTED`): são do
  texto da lógica, no mesmo job.

**Conferência:** depois de escrever, a tela é lida de novo e comparada com o texto editado, elemento por elemento: tipo,
fatos, filhos e a ObjectKey de tudo o que a edição manteve (inclusive as linhas de texto). Se não for o texto editado, nada
fica (`HTML_EDIT_NOT_APPLIED`). As únicas normalizações aceitas são listadas em `normalized`: o CSS só reformatado e o nome
que a plataforma dá a um input novo quando a edição não escreveu `id`. A resposta traz o `next` (o `htmlSha256` da tela
depois da edição) para a próxima edição.

**Base e merge de 3 vias (plano 3.4):** se a tela mudou desde a leitura do `basedOn` (outra captura), a edição é juntada em
3 vias: base = o texto da leitura do `basedOn` (guardado com a tabela de chaves), local = a tela agora, estrangeira = a base
com a edição. Elementos casam pela ObjectKey (nunca pelo `k`, que renumera), slots pelo nome, o `else` pelo seu If, linhas
de texto pelo valor. O que só um lado mudou vem desse lado; o que os dois mudaram fica com a versão da entrega (regra do
dono) e é listado em `rebased[].conflicts`; widget que o Studio acrescentou fica. Elemento que a edição mudou e o Studio
removeu não volta com a chave: `HTML_KEY_FOREIGN` com o texto atual. Sem o texto da base guardado (armazenamento antigo),
cada `k` passa pela ObjectKey e o elemento enviado substitui o atual. Sem a tabela de chaves: `HTML_BASE_CHANGED` com o texto
atual, uma recusa. Depois disso, o merge nativo da entrega leva o candidato ao módulo vivo, como em toda entrega.

CLI frio: `anvil html-edit --oml <captura> --data <op.json> [--out r.oml]` (uma op) e
`anvil html-edit-battery --oml <captura> [--seed N] [--per-kind N] [--root Tela] [--out rel.json]` (a bateria). O mesmo em
`anvil-odc`.

## Editar por elemento e por texto (CX16)

Mudar parte de uma tela ou bloco não reenvia o documento nem o elemento inteiro: a op `html` leva `edits`, uma lista de
edições sobre a **leitura** (`basedOn {capture, html}` da `ssam_map view:"html"`), e o kernel escreve o documento inteiro a
partir dela (`HtmlElementEdits.cs`); o documento segue o caminho de hoje (plano, merge de 3 vias quando a tela mudou,
escrita, conferência). No `ssam_code`: `{action:"write", part:"html", element:"<tela>", basedOn:{capture, html}, edits:[...]}`.

```json
{"op":"html","data":{"screen":"AdminStations","basedOn":{"capture":"<sourceSha256>","html":"<htmlSha256>"},
  "edits":[{"set":"w17","attributes":{"class":"toolbar admin-nav"}},
           {"into":"w17","insert":"<a class=\"btn-ghost\" onclick=\"GoAdminRentals\">Aluguéis</a>"},
           {"find":"Pontos de partida.","with":"Estações"}]}}
```

| Forma | Base | Efeito |
|---|---|---|
| `{find:"<texto exato>", with:"<texto>"}` | leitura e texto de job | troca a única ocorrência; `with:""` apaga o trecho; sobre a leitura, os `k` do `with` são os do trecho (na mesma ordem; em outra, só com cada elemento que muda de lugar levando o seu próprio texto) |
| `{set:"w17", attributes:{"class":"a b","os-Width":null}}` | leitura | só a tag de abertura; `null` remove; nunca `k`; filhos intactos |
| `{replace:"w17", with:"<div …>…</div>"}` | leitura | o elemento inteiro (um If com o seu `<div else>`); raiz sem `k` herda `w17` |
| `{delete:"w17"}` | leitura | o elemento (e o seu else) |
| `{after:"w17", insert:"…"}` / `{before:"w17", insert:"…"}` | leitura | elementos novos (sem `k`) como irmãos |
| `{into:"w5"`, `"w5/Content"`, `"w23.true"`, `"w23.false"` ou `"/", insert:"…", at:"first"\|"last"}` | leitura | filhos novos (padrão `last`); um slot ou um else que a leitura não escreve é criado |
| `{move:"w9", after\|before\|into:"…"}` | leitura | o mesmo elemento, `k` mantido |

Endereço: o `k`, o slot `k/Nome`, o ramo `k.true`/`k.false`, a raiz `/` ou `@<ObjectKey>` (pela tabela de chaves). Todas as
edições endereçam a base (uma `find` e um endereço sobre o mesmo texto se sobrepõem); o texto inserido ou trocado é escrito
na forma canônica da sua profundidade e o resto da base fica byte a byte; `set` e `replace` mantêm o elemento; uma edição
sem efeito devolve a base. Recusas, todas numa resposta, com `pointer` `/edits/<j>` e `element` (a linha da tag) ou
`candidates`: `HTML_EDIT_TARGET_UNKNOWN` (endereço que a leitura não tem), `HTML_EDIT_TEXT_NOT_UNIQUE` (0 ou ≥ 2
ocorrências, com as linhas), `HTML_EDIT_OVERLAP`, `HTML_KEY_TWICE`, `HTML_EDIT_INVALID` (forma; também uma `find` cujo
`with` tira, troca ou acrescenta um `k` do trecho: o `k` é a identidade do elemento, e sem ele o elemento seria outro e o
rebase perderia o que o Studio mudou nele; mude-o por `set`, `replace` ou `move`). Dois elementos trocados de lugar dentro
de uma `find`, cada um com o seu `k` **e o seu próprio texto**, são o mesmo par recolocado (só `place`: nada criado, apagado
ou movido para outro pai, nenhuma ObjectKey nova). **Identidade por `k` (3ª rodada, M5)**, em toda edição que escreve de
novo `k` da leitura (`find`/`with`, `replace`/`with`, `replace "/"`): quando a ordem dos `k` muda, os elementos que mudam de
lugar (os que ficam fora da maior sequência mantida em ordem) têm de levar o seu próprio texto, filhos incluídos, na forma
canônica. Um `k` que muda de lugar **e** de texto ao mesmo tempo é recusado com `HTML_EDIT_INVALID`, `keys` com os `k` e
`element` com a linha da tag: com os `k` de dois contêineres trocados e o conteúdo no lugar, o plano moveria os filhos de um
para o outro com ObjectKeys novas (2 × 15 objetos no `Login`) para uma tela que se lê igual, e o rebase perderia o que o
Studio mudou neles. A correção: mover cada elemento inteiro com o seu texto (ou `{move}`) e mudá-lo por `{set}`; um `set`
e o `move` do mesmo elemento vão juntos na mesma lista (o `move` escreve o elemento com os atributos do `set`). Um `k` que
muda de pai sem mudar a ordem dos `k` (sai do pai, por exemplo) continua sendo o `move` + `set` declarado de hoje. Com a leitura guardada na
loja, o preflight (`check-job`) já diz tudo isso em ms, sem o modelo. Um problema do plano num `k` que uma edição tocou
leva `edit: <j>`; a resposta lista `normalizations [{rule:"html-element-edits", from, edits, touched}]`. Sem a leitura
guardada e com a tela mudada: `HTML_BASE_CHANGED` com o texto atual e, quando a tabela de chaves está guardada,
`current.elements [{address, k, text}]` com o texto atual de cada elemento endereçado. A forma `edit` (elementos inteiros)
e a forma documento continuam valendo como antes.

**Correção de um job recusado ou checado:** `basedOn {job, sha256}` (o `nextBasedOn` da recusa, também na recusa do
`ssam_code check`), `element` (o nome de um `<screen>`/`<block>` do job, a tela de uma op de edição, `Tela.Action` ou
`Action` de um texto de lógica, ou `ddl`) e `edits:[{find, with}]`; outros elementos em `also:[{element, edits}]`. O
`ssam_code` gera o JSON Patch dos textos (`html-edits.mjs`) e entrega pela rota de patch de hoje; nada do job viaja de novo.
Problemas: `EDIT_ELEMENT_UNKNOWN` (com os elementos que o job tem), `EDIT_TEXT_NOT_UNIQUE` (com as linhas), `EDIT_OVERLAP`
(duas edições no mesmo trecho, ou com o `patch` do modelo no mesmo caminho), `BASE_CHANGED`.

## Checagem estática (CX16)

**Desligada por padrão desde a 4ª rodada (plano B, acordado com o dono):** a pré-checagem de UI só roda com
`SSAM_UI_PRECHECK=1` (ou `on`, `true`). Desligada, toda chamada segue como antes do CX16. A revisão cx16-3 (M3) mostrou que,
com o worker residente (o padrão), o `check-job` entra na mesma fila do apply. O paralelo vira série, e com um apply de mais
de ~12 s o `check-job` estoura na fila e a recusa sai sem os problemas estáticos. A edição por elemento (`data.edits`,
acima) não depende da pré-checagem e continua ligada. O que segue descreve a pré-checagem ligada.

Antes de qualquer etapa de Studio (`o11_deliver`, relay do `studio_deliver`) e antes do apply (`ssam_job`, `o11_job`,
`ssam_code check`), um job de telas ou blocos passa pelo `check-job` da faixa com o índice do módulo
(`ui-precheck.mjs`, `Preflight\StaticChecks.cs`): `check-job --job J [--module-index F] [--producer-index Nome=F]…
[--ui-catalog F]… [--basis-fresh true|false]`. Sem as flags novas a saída é a de hoje; com elas ganha
`phases:["preflight","static"]` e `static:{basis, checked, skipped, elapsedMs}`.

| Classe | O que decide | Fonte |
|---|---|---|
| S1 | `<Block name>` existe (bloco do job, do módulo, importado ou do catálogo de UI) | job, índice (com as linhas de referência `*BlockSignature`), índices de produtor, `reference`, digest, catálogo |
| S2 | contrato do bloco: `<slot name>`, `:Input` e os obrigatórios, `@Evento` | `<block>` do job; catálogo (aviso) |
| S3 | destino de evento: screen action de `actions=` ou tela | documento, índice (com `*ScreenSignature`), índices de produtor |
| S4 | `actions=`/`data-actions=` têm texto de lógica no job (ou já existem na tela) | job, índice |
| S5 | raiz de toda expressão: dado do documento, do módulo, do job ou importado; um TIPO usado como valor (`value="Station.Id"` → `Opções.Lista.Current.Id`); `X.Lista.Current.Entidade.Attr` sobre `Entidade List` → `.Current.Attr`; tipo de produtor referenciado fora do `reference` (`REFERENCE_MISSING`, com o patch) | documento, job, `reference`, índices |
| S6, S7 | `roles=`; tela ou bloco novo com nome que o módulo já tem (`HTML_ROOT_EXISTS`) | índice, `reference`, job |
| L1-L3 | data action que atribui variável da tela; saída ou entrada de screen action com o nome de um dado da tela (`NAME_COLLISION`) | job |
| WithModule, WithBase | as regras de hoje sobre o índice (agora também com `reference`) | índice + digest |
| functions | `FUNCTION_UNKNOWN` da fase base: chamada a um nome que não é built-in da faixa, nem elemento do módulo ou das referências, nem nome que o job declara | built-ins (Studio ou catálogo O11), índice, job |

A forma `{screen, basedOn, html:<documento>}` é a edição daquela tela (`ScreenHtmlEdit.IsEdit`, a mesma regra do apply):
nunca uma raiz nova (sem `HTML_ROOT_EXISTS`). Um job com `expectValid:false` pede ao Verify o veredito: S1-S7, L1-L3,
WithModule e WithBase não rodam e ficam em `static.skipped`, como no preflight e no `JobRunner`.

Erro só com evidência positiva: um nome que falta num índice que não é provadamente o módulo vivo (`--basis-fresh false`)
é aviso; nome que o job ou um gerador pode criar nunca é problema; o que precisa do Studio (built-ins da ODC, assinatura
de callee) é pulado e listado em `static.skipped`. O `check-job` diz em `static.complete` se o caminho do apply (fase base,
apply, Verify) ainda pode acrescentar algum problema, e em `static.rest` o que falta; `complete` só quando o job não se lê
ou toda op é recusada inteira pela forma.

Regra de parada (a regra do dono é UMA recusa com tudo). **3ª rodada (M3): o `check-job` roda junto com o caminho do
apply, nunca antes dele** (`startUiPrecheck`): no `ssam_job`/`o11_job`/`ssam_code check` ele parte antes de
`prepareIntegrationJob`/apply e só é esperado na junção; no `o11_deliver` parte depois da captura por chave (que a fase de
build reaproveita) e roda junto com o apply do build; no relay do `studio_deliver` roda junto com o relay. A pré-checagem
**nunca constrói índice**: usa o índice guardado (ou o de uma captura de mesmo conteúdo); sem ele, as classes que dependem
do índice são puladas e `static.skipped` diz isso (`SSAM_UI_PRECHECK_INDEX_MS` deixou de existir). Os problemas vão para a
recusa do caminho do apply (`joinPrecheck`: o mesmo problema uma vez, com o texto do apply; `phases` com `"static"`;
`static {complete, rest, carried, joined}`). A pré-checagem só responde sozinha com `static.complete` (o job não se lê ou
toda op é recusada inteira pela forma), e só onde ainda há passo a poupar: no `o11_deliver`, o passo do Studio espera o
veredito (o build rodou enquanto isso) e para ali — `{code:"PREFLIGHT_REFUSED", stage:"static", stoppedBefore:"studio",
problems, static, nextBasedOn, continuation}`; quando toda correção é certa (`edit:{element, find, with}` em cada problema),
a continuação é UM `ssam_code` com `basedOn {job, sha256}` e as edições; senão, a leitura do primeiro elemento. Um job
headless e o relay ODC são o próprio caminho do apply: mesmo com `complete`, juntam. Se o apply aceita, os erros estáticos
não eram prova: só o diário `ui-precheck.jsonl` os guarda. Aviso nunca para. Sem `SSAM_UI_PRECHECK=1` (o padrão desde a 4ª rodada) não há pré-checagem;
com ela, `SSAM_UI_PRECHECK_STOP=error` volta à regra da 1ª rodada (qualquer erro recusa antes do apply, em série; opcional, nunca o
padrão).

## Garantias

- **Ponto fixo:** `ScreenHtmlDocument.Compare(html)` decodifica o texto e compara com a forma canônica lida do modelo;
  reaplicar o texto lido dá zero diferenças. Toda edição vira uma diferença (`set`, `create`, `delete`, `children`,
  `foreign`, `replace`).
- **Determinismo entre processos:** o Model API dá actions, eventos, argumentos, partes de aggregate e eventos de bloco em
  outra ordem a cada carga. A leitura escreve os widgets na ordem do modelo (é a página), os membros de uma lista ordenada
  do dono na ordem dela (parâmetros, variáveis, `Sorts`, extended properties) e o resto por tipo, nome, o que o membro sem nome diz (destino, evento, condição; extrator 2) e chave. A mesma
  captura dá o mesmo texto e o mesmo `htmlSha256` em todo processo.
- **Uma raiz nunca derruba o módulo:** uma tela que a leitura não consegue escrever sai com o erro como problema dela.

Medido no corpus do plano (`kernel/tests/contracts/screen-html/corpus.json`; 21 módulos O11 e 4 ODC reais), em 2026-10-11:

| Conjunto | Telas / blocos | Widgets | Ponto fixo | Representados (não opacos) | p90 da leitura por tela | Mediana do HTML de uma tela |
|---|---|---|---|---|---|---|
| O11 apps reais | 140 / 329 | 38.076 | 100% | 99,86% | 38,5 ms | 5.879 B |
| ODC apps reais | 46 / 77 | 4.621 | 100% | 99,11% | 36,7 ms | 5.751 B |
| **Reactive/Mobile reais** | 186 / 406 | 42.697 | **100%** | **99,78%** | 37,3 ms | 5.787 B |
| O11 templates (fixture) | 3 / 8 | 148 | 100% | 100% | | |
| O11 Traditional (fixture) | 5 / 7 | 161 | 100% | 0% (D2) | | |

O ODC tem 2 raízes a mais que a contagem do plano (`FloodQuotes`: a tela `Main` e o bloco `OpenDialogOnReady`, sem
widgets). Os 93 opacos dos módulos reais: 9 `TableRecords`, 38 `HeaderCell`, 38 `RowCell` e 8 `MobileWidget`. A leitura
do módulo (uma vez por captura, guardada com ela no leitor residente) leva de 0,2 a 4,6 s (DCIPS_Staff_Cases, 86 mil
elementos fora do corpo das actions), além da carga da captura.

**Volta (C2), medida no mesmo corpus em 2026-10-11** (edições sintéticas geradas das telas reais: classe, texto,
expressão, filho novo — container, texto, container com `id`, input ligado a uma variável —, remoção de folha que nada usa,
troca de irmãos, evento; cada uma aplicada pela op e desfeita):

| Conjunto | Semente / por tipo | Edições | Relidas iguais (texto e chaves) | p90 por edição (máquina carregada) |
|---|---|---|---|---|
| O11 apps reais (21 módulos) | 1 / 1 | 2.690 | **100%** | 55 a 472 ms, conforme o módulo |
| ODC apps reais (4 módulos) | 1 / 1 | 676 | **100%** | 104 a 363 ms, conforme o módulo |
| O11 + ODC, segunda rodada | 7 / 2 | 6.224 (4.981 + 1.243) | **100%** | |
| Fixtures `reactive-ui`, `mobile-ui`, `insurance-reactive` | 1-3 / 1-2 | 97 + 96 + 252 | 100% | |

Por tipo (semente 1): O11 classe 457, texto 310, expressão 323, filho 458, remoção 410, troca 411, evento 321; ODC 119, 50,
83, 118, 111, 111, 84. Em todas, a conferência da op passou (nenhuma ObjectKey mudou fora do editado: o escritor recusa
qualquer escrita fora da raiz editada) e, depois do desfazer, a tela leu de novo o texto original.

Os 2 pedidos de correção do transcript de 2026-10-10 (plano 4.5), repetidos como C sobre as capturas da época: 2 chamadas
cada (a leitura e a entrega), 0 recusas.

| Pedido | Hoje (transcript) | Como C: leitura | Como C: aplicação + conferência | Ops |
|---|---|---|---|---|
| ajuste da FarmaVirtual (20:48) | 2,1 min, 35 chamadas, 2 com erro | 1,3 a 2,5 s | 7,9 a 8,8 s | 9 create, 15 set, 2 move, 1 place; o `Visible` da sessão virou `If` |
| "ta tudo sem css" | 2,1 min, 27 chamadas | 1,3 a 1,5 s | 4,0 a 4,7 s | o `<style>` da tela |

Tempos no processo de teste com a captura carregada; pela CLI fria (subir o processo e carregar a captura), 7 a 8 s a
leitura e 17 a 20 s a aplicação. A entrega ao vivo soma o snapshot e o merge nativo do Studio (não medido aqui).

## Manutenção

- Toda mudança do texto sobe `ScreenHtml.Extractor`.
- Testes: `kernel/tests/Shared/ScreenHtmlTests.cs` (regras, as duas faixas: forma, ponto fixo, mesma saída com os conjuntos
  em outra ordem, edições, parser, contrato) e `ScreenHtmlCoverageTests` / `ScreenHtmlCoverageOdcTests` (o corpus inteiro,
  com os pisos da seção 4.2 e o aceite da C1; sem as capturas, pulam com aviso). Fachada:
  `platforms/odc/facade/tests/module-html.test.mjs`.
- Testes da volta: `kernel/tests/Shared/ScreenHtmlEditTests.cs` (as duas faixas, sobre um modelo de teste: cada tipo de
  edição, recusas numa resposta com o patch do `Visible`, merge de 3 vias), `ScreenHtmlEditJobTests` (O11: a op dentro do
  job, o rebase com conflito, os 2 pedidos do transcript, a bateria nas fixtures e no corpus) e
  `ScreenHtmlEditBatteryOdcTests` (ODC: fixture e corpus). A seção `c2` do manifesto guarda a semente, o número de edições
  por tipo, o piso por faixa (o que estas capturas dão) e os caminhos das capturas do transcript; sem elas, pula com aviso.
- Uma construção que a bateria acha falhando é defeito do motor: a conferência recusa (`HTML_EDIT_NOT_APPLIED`) e nada fica.
- Regra de corte do plano: a view, a forma edição e a forma documento só são ligadas no MCP com o ponto fixo e a bateria em
  100% no corpus (`docs/TEXTO-SSAM.md`).

## Criar tela (B1): a forma documento da op `html`

Etapa B1 do plano (seções 1, 2 e 8). Decisões do dono de 2026-10-11: criar tela é a forma documento da op `html`, não uma op
nova; Visible, ForEach fora do padrão e JavaScript que já existem são preservados e listados, e os novos são recusados com o
patch do padrão.

Código: `kernel/src/Anvil.Core/Kernel/ScreenDocument.cs` (a forma, as regras sem módulo, o nome mais próximo, o documento
corrigido) e `Verbs.ScreenDocument.cs` (o construtor direto). A prova de recriação está em `Verbs.ScreenRecreation.cs` e
`ScreenRecreationProof.cs` (`anvil html-recreate`, também em `anvil-odc`).

### A chamada

```json
{"ops": [
  {"op": "spec", "data": {"entities": [{"name": "Pedido", "attributes": [{"name": "Numero", "type": "Text", "length": 20}]}]}},
  {"op": "html", "data": {"html": "<screen name=\"Pedidos\" roles=\"Registered\" actions=\"Buscar\" data-actions=\"GetTotais\"> ... </screen>"}},
  {"op": "logic", "data": {"flow": ["action Pedidos.Buscar\n  refresh GetPedidos\n  end\n",
    "data action Pedidos.GetTotais\n  out Total: Integer\n  assign Total = 0\n  end\n"]}}
]}
```

O op `logic` pode ser o texto de lógica (`ssam-flow/1`, `docs/TEXTO-LOGICA.md`): o cabeçalho sem `@key` nomeia o dono antes do
nome (`action Pedidos.Buscar`, `data action Pedidos.GetTotais`). A forma JSON (`{"actions": [{"name": "Buscar", "kind":
"screen", "owner": "IMobileScreen:Pedidos", "steps": [...]}]}`) continua valendo.

- `data.html` começando por `<screen` ou `<block` (comentários antes valem) é a forma documento. Sem `parent`. A forma
  fragmento (`parent` + html) e a forma página (`data.screen` + manifesto) continuam iguais.
- O texto é o que `ssam_map view:"html"` lê: as mesmas tags, atributos, nomes e `os-<Propriedade>`. O contrato publicado está
  em `api --op html`, chave `document` (`ScreenDocument.Schema()`).
- Uma tela ou bloco por op. O conteúdo vai no bloco de layout: `<Block name="LayoutTopMenu"><slot name="MainContent">`.
- `actions="A, B"` nomeia as screen actions. Um op `logic` do mesmo job, depois do `html`, declara cada uma: um texto
  `action <Tela>.A` ou, em JSON, `kind` screen com `owner` `IMobileScreen:<Nome>`. Elas nascem antes do conteúdo (nome e
  inputs), para os eventos ligarem, e o op `logic` preenche o corpo no lugar, mantendo a chave e os inputs (o recibo diz
  `filledShell`). `data-actions="D"` vale com um texto `data action <Tela>.D` (ou um op `logic` de `kind` data), criado depois
  do documento.
- Dados: `<input name type default>`, `<var name type default>` e `<aggregate>`. O aggregate tem a forma curta, que vira a
  longa: `from="Pedido" join="StatusPedido on Pedido.StatusPedidoId = StatusPedido.Id" where="..." sort="Pedido.CriadoEm desc, Pedido.Numero" max="50"`.
  A forma longa da leitura (`os-AliasedSource`, `os-Join`, `os-Filter`, `os-Sort`) também é aceita. Entidade nova é sempre um
  `spec` antes; nome que não existe nunca cria entidade.
- Eventos: `on<evento>="Destino(Param = expressão, ...)"` ou `Destino(expressão, ...)` pela ordem dos inputs. Valem
  `onclick`, `onchange`, `onready`... e os eventos HTML (`onblur`, `onkeypress`) de HTML Element e Container. Em `<Block>`,
  `@Evento`. As outras propriedades do evento vão em `os-on<evento>.<Prop>`.
- Switch, Upload, Icon e ButtonGroup (`switch`, `upload`, `i icon`, `button-group`/`button-group-item`) são linhas da tabela
  única `ElementWidgetMap.LanguageElements`. Fragmento, documento, leitura e importador usam a mesma tabela, e um teste prende
  essa tabela à da leitura (`ScreenHtml.WidgetTags`).

### Como roda

O parser lê o texto e as regras sem módulo são verificadas. Depois o construtor cria tudo numa passada no Model API, com o pai
na mão: raiz, dados, actions do job, widgets, alvos de label e eventos. Não há uma op por widget.

Os nomes são resolvidos pelas regras da leitura: a própria tela, o módulo e as referências, as outras telas e os tipos. O que o
texto não diz fica no padrão da tabela (`ScreenHtml.DefaultOf`), porque um widget novo nasce com valores próprios.

Documento recusado não deixa nada: a raiz é apagada e o op `logic` volta ao que o job dizia.

### Fidelidade: o que o documento diz é o que a tela tem (relato do dono de 12/10/2026)

O relato: as telas `BaterPonto` e `Espelho` do `FolhaPonto_UI` entregues pela forma documento saíram sem estilo e com
`Hoje · {{ FormatDateTime(...) }}` como texto literal no Studio, e a entrega disse "entregue". Reproduzido com a CLI sobre a
captura e o job do dono: o CSS do `<style>` de `BaterPonto` estava na folha da tela, mas `Espelho` usava as mesmas 50 classes
sem regra nenhuma (o CSS do protótipo foi dado só no primeiro documento), e as 4 linhas com texto e ligação viraram Text com as
chaves. Código: `ScreenDocument.Fidelity.cs` (sem módulo) e `Verbs.ScreenDocument.Fidelity.cs` (o compilador e as conferências);
a regra das ligações é uma só, `ScreenHtml.Run`/`Unsugar`, a mesma da forma documento e do decodificador (C1, C2).

- **CSS.** Todo `<style>` do documento, onde estiver (filho da raiz, dentro de um `div`, dentro de um `<Block>`), e o
  `data.css` do op vão para a folha da própria tela ou bloco, na ordem do documento, como escritos (um bloco só é exatamente o
  seu texto: a leitura o escreve de volta como um `<style>`). `<style scope="theme">` vai para o tema padrão do módulo, como
  escrito, entre os marcadores da raiz (`/* anvil:html <Raiz> */`, uma segunda compilação troca o bloco). `type="text/css"`,
  `id` e `nonce` não mudam nada. Outro atributo não tem lugar: `HTML_STYLE_UNPLACED`; com `media` o patch leva o CSS para o fim
  do `data.css` como o seu bloco `@media`. CSS que o tema não renderiza (`light-dark()`, `color-mix()`), no `<style>` ou no
  `data.css`, é `CSS_FUNCTION_UNSUPPORTED` com a folha renderizada no patch (o mesmo do `data.css` e do `set StyleSheet`). O
  patch é um só (o documento corrigido e o `data.css`) e é conferido antes de ser oferecido.
- **Ligações.** Uma linha com texto e ligações é uma Expression, a concatenação: o literal entre aspas (aspas dobradas), a
  ligação entre parênteses quando não é nome, membro, chamada ou literal (`"Total: " + (A + B)`). A ligação fecha no primeiro
  `}}` fora das suas strings e chaves (`{{ { A: { B: 1 }} }}` é um record). O mesmo vale para um atributo (`class="a {{ X }}"`).
  Duas ligações coladas no começo (`{{ 1 }}{{ 2 }} itens`, `{{ Horas }}{{ Minutos }} h`) começam com o texto vazio
  (`"" + 1 + 2 + " itens"`): sem ele o `+` somaria os dois números e a página mostraria `3 itens`, não `12 itens`.
  `{{` que não fecha, `}}` sem `{{` e `{{ }}` sem expressão: `HTML_BINDING_INVALID`; chaves literais vão em `<text>`. Nos
  atributos, o preflight confere os mesmos valores que a compilação escreve como texto com ligações: `class` e toda propriedade
  estendida (`ext:<nome>`, ou um atributo que a tabela do tipo não nomeia e que não é evento `on…`, argumento `:`, handler `@`,
  `html:` ou `os-`). A regra é uma só, `ScreenDocument.ExtendedName`, usada pelo preflight e pela compilação, e o problema é o
  mesmo (`AttributeBindingProblem`): `data-z="a }} b"` vem na primeira recusa, junto com o resto, e uma vez só. A
  leitura nunca escreve uma linha nua com `{{` ou `}}` (`PlainRun`, `PlainLiteral`), por isso o ponto fixo não muda
  (`Extractor` 3). Inteiro, data e booleano concatenam com texto sem conversão escrita (o Verify aceita).
- **Conferências na mesma aplicação, antes da resposta.** O modelo escrito é lido de novo: a folha da raiz é o CSS do documento
  (`HTML_STYLE_DROPPED`), o bloco do tema é o CSS do `<style scope="theme">`, nenhum Text feito de uma linha do documento guarda
  `{{` ou `}}` (`HTML_BINDING_LEFT`), nenhuma Expression nova está vazia (`HTML_EXPRESSION_EMPTY`, também `<expr>` sem
  `value`). Qualquer falha: nada fica (a raiz sai, o tema volta) e a recusa traz todos os problemas.
- **Classes sem regra.** Toda classe que o documento usa (as palavras de `class` e os literais das suas expressões, e o
  `ExtendedClass` de um bloco) precisa de uma regra na folha da página, nos temas do módulo ou no OutSystems UI (lista das
  classes do OutSystems UI 2.28.1 em `Kernel/OutSystemsUiClasses.txt`; `fa` e `fa-*`). As que não têm vêm no aviso
  `HTML_CLASS_NO_RULE` (A03: não bloqueia; `highWarnings`, primeiro na entrega), com onde mais o módulo as escreve (a folha de
  outra tela só vale nela) e, quando outro documento do mesmo job as tem no seu `<style>`, a sugestão com o patch que põe esse
  `<style>` no tema (`scope="theme"`). Tema padrão de outro módulo: o aviso diz que o CSS dele não foi lido.

O job do dono reaplicado (`FolhaPonto_UI-20261012135850`, `FolhaPonto_CS-20261012135019`): `BaterPonto` com a folha de 8.312
caracteres e `{{ "Hoje · " + FormatDateTime(ResumoAtual.Dia.Data,"dd/MM/yyyy") }}`; `Espelho` com as 3 linhas como Expression
e o aviso das 50 classes, todas só na folha de `BaterPonto`, com o patch do tema; com o patch, o CSS vai para o tema
`FolhaPonto_UI` e nenhuma classe fica sem regra. As 13 raízes do módulo lidas de novo no ponto fixo (0 diferenças).

### O HTML que tem uma leitura nativa (famílias da sessão do dono de 12/10/2026)

A sessão do `VisitaCerta_UI` (4 telas e um popup escritos à mão: 22 escritas, 13 recusadas, 9 defeitos depois de publicar).
Cada defeito virou a sua família, corrigida por uma regra do motor, a mesma na forma documento e na forma edição, nas duas
faixas, só sobre o que o texto escreve novo (elemento com `k` da leitura mantém o que tinha). Quando há uma leitura só, o
motor escreve a forma nativa e lista em `normalized` (no relato do op e no da edição). Código: `ScreenHtmlNative.cs`,
`ScreenHtml.Runs`, `ScreenHtml.DefaultOf(..., inPopup)` e `Verbs.NativeWidgets.cs`.

- **`<svg>` inline vira elemento nativo.** Desenhado com `currentColor` ou com uma cor só (ícone): `<span>` com as classes do
  svg, `ssam-icon` e uma classe de máscara por desenho (`ssam-icon-svg-<hash>`, a máscara do importador: `mask:url("data:image/svg+xml,…")`
  com `xmlns`, na folha da própria tela, uma regra por desenho); o span guarda o tamanho (`width`/`height` do svg) e a cor
  (uma cor só). Os seletores `svg` e `span` do CSS do documento e do tema que a tela mostra passam a valer para os spans
  (`:is(svg, :where(.ssam-icon))`, `span:not(:where(.ssam-icon))`, o item 5 do importador; idempotente). Svg com gradiente,
  várias cores, texto ou estilo: Image do próprio desenho (data URL). `SVG_MASK`, `SVG_IMAGE`.
- **`<img src>` com URL, data URL, arquivo (`logo.svg`) ou `{{ }}`** é Image de Type External com essa Url (`IMG_EXTERNAL`).
  Nome que resolve (imagem do módulo, `Image:User`, `Dono.Nome`) fica como está. Com `os-Type="External"`, imagem do módulo em
  `src` sai (a plataforma não guarda Image ali: `IMG_SRC_DROPPED`). URL com outro Type: `HTML_IMAGE_SOURCE`.
- **Espaço ao lado de elemento inline.** Na mesma linha, o espaço entre um texto e um elemento inline (`span`, `b`, `em`,
  `a`, `button`, `i`, `img`, `expr`…) é da página: `por <b>menor</b> para` guarda `por ` e ` para`; só espaço entre dois inline
  é um run (`<b>a</b> <em>b</em>`). Indentação e quebra de linha continuam sendo layout. A leitura escreve esses runs em
  `<text>` (ou na expressão), então o ponto fixo não muda.
- **Atributo com ligação.** Onde a propriedade é expressão (pelo tipo do Model API), a ligação é a expressão
  (`placeholder="Buscar {{ X }}"` é `"Buscar " + X`, como o `class`). `style` com ligação num widget cujo `style` é o Custom
  Style (texto que a plataforma nunca avalia) é o atributo `style`, que toma expressão (`ext:style`, `STYLE_EXPRESSION`).
  Propriedade que toma literal (texto, número, enum, booleano): ligação constante é o literal (`{{ "abc" }}` é `abc`,
  `LITERAL_CONSTANT`); referência por ligação de um nome (`bind="{{ Busca }}"`) é o nome; o resto é `HTML_BINDING_LITERAL` (a
  página mostraria as chaves). A leitura escreve inteira (`{{ texto }}`) a expressão que tem `{{`/`}}` dentro (`Extractor` 4).
- **Prosa onde vai expressão** (`placeholder="Buscar por nome, cidade…"`: dois operandos sem operador, ou `…`, `?`, `!`): a
  compilação lê o Verify na mesma chamada, nomeia o atributo certo (a propriedade da mensagem, nunca o primeiro atributo) e
  oferece o literal (`placeholder='"Buscar por nome, cidade…"'`) como patch conferido.
- **Decimal em estilo inline.** O runtime transforma um valor numérico inline em inteiro (`opacity:0.7` saiu `opacity: 0`
  na página publicada, `font-size:11.5px` ficou). Valor que é número com fração (`opacity`, `line-height`, `flex`…) é
  escrito `calc(n)`: o mesmo valor para o CSS, que o runtime mantém (`STYLE_NUMBER`).
- **Popup.** Todo evento de widget dentro de um Popup nasce com Transition `Fade` (a plataforma; no corpus não há evento
  dentro de popup sem ele). Esse é o padrão ali: a leitura não escreve, a edição e o documento não estranham; um widget criado
  ou movido para dentro (ou para fora) fica no padrão do lugar onde está.
- **Tema sem tema base.** Sem OutSystems UI, o span `.btn-animation` que todo clique de Button acrescenta não tem regra: não
  anima, nunca sai e, num botão flex com `gap`, cada clique o alarga. Todo tema que o job escreve (criado, `BaseTheme` ou
  `StyleSheet`, também o do importador) e que termina sem tema base recebe uma vez o CSS desses elementos, entre
  `/* ssam:native-widgets */` (fora do fluxo e animado, então o runtime o remove): `THEME_NATIVE_WIDGETS` no recibo.

Testes: `ScreenHtmlFamilyTests` (regras com casos gerados sem módulo; prosa com patch; tema sem base; as famílias nas
fixtures e no corpus O11) e `ScreenHtmlFamilyOdcTests` (fixture e corpus ODC), por `ModelHost.HtmlFamilyBattery`: cada
família acrescentada a um container de cada tela e bloco pela forma edição (desfeita depois) e uma tela nova com todas pela
forma documento; o módulo relido tem a construção nativa de cada uma e a leitura é ponto fixo.

### Recusas: uma vez, com todos os problemas

- Todo problema do documento vem numa recusa só, cada um com linha e coluna. Valem os do preflight (sem módulo), os da
  compilação (nomes) e os nomes errados dentro de expressões. Estes últimos vêm do Verify da página até onde ela foi
  construída, lido só para nomes e sintaxe.
- Nome inexistente (`HTML_NAME_UNKNOWN`) traz os 3 mais próximos do mesmo tipo. O critério é distância ≤ 2 ou prefixo/sufixo
  comum ≥ 70%. Diferença só de caixa não conta.
- Quando a correção é única, o problema traz o **documento corrigido** como patch (`replace` em `/ops/i/data/html`). O patch
  é o mesmo em todos os problemas e já tem todas as correções certas.
- **O patch é conferido antes de ser oferecido** (bloqueio B4 da conferência de 12/10/2026). Sem módulo (preflight), o texto
  corrigido passa nas regras que ele corrige. Com o módulo (apply), o documento corrigido é **compilado na mesma sessão**, com o
  Verify das suas expressões e de todo erro sobre o que ele escreve (um botão sem On Click), e apagado em seguida (nada da
  conferência fica): ele só sai como patch quando a compilação não tem nenhum problema além dos que nada corrige (por código e
  mensagem, ou no elemento de um deles). A correção em cujo elemento a compilação acha um erro novo sai, e as outras são
  compiladas de novo. Se as correções que pedem nomes do módulo (nomes,
  iterações) o impedem, sai o documento só com as que não pedem (remover, pôr dentro de um If); se nem esse compila, nenhum
  patch, e cada problema fica com a sua correção escrita.
- Regras do dono sobre o que é novo, com patch conferido antes de ser oferecido:
  - `HTML_VISIBLE`: `os-Visible` novo. O patch põe o elemento dentro de `<div if="...">` (U1).
  - `HTML_SCRIPT`: `<script>`, `javascript:` ou JavaScript em evento. O patch remove (L5); JavaScript só em client action
    isolada e nomeada. Um `onclick="javascript:alert(1)"` não vira também um nome desconhecido `alert`. No clique de um
    `<button>` ou de um `<a>` não há patch (o widget exige o On Click): a correção escrita pede o destino.
  - `HTML_FOREACH`: iteração de outro framework (`v-for`, `x-for`, `ng-repeat`, `*ngFor`, `th:each`, `foreach`). O patch
    escreve `list` e troca a linha em todas as expressões do elemento (`{{ }}`, `if`, `list`, eventos, entradas de bloco,
    `os-*`; nunca texto puro nem `class`): `n` é o item corrente (`v-for="n in Nomes"` + `{{ n }}` dão `list="Nomes"` +
    `{{ Nomes.Current }}`), `n.X` o seu membro, e a linha de um aggregate do documento nomeia a entidade
    (`v-for="p in GetPedidos"` + `{{ p.Numero }}` dão `list="GetPedidos.List"` + `{{ GetPedidos.List.Current.Pedido.Numero }}`).
    O nome da linha (`n`) não sai como nome desconhecido: é o `HTML_FOREACH`.
  - `HTML_JSON`: `JSONSerialize`/`JSONDeserialize` em ligação (L6).
- Também recusa: `HTML_RECORD_LITERAL` (record literal `{ A: x }` em expressão O11, que o parser do O11 não lê; o do ODC
  lê), `HTML_ROOT_EXISTS` (a tela já existe), `HTML_KEY_FOREIGN`, `HTML_OPAQUE_TOUCHED` e `HTML_TRADITIONAL`.
- Elemento com `k` de uma leitura (`basedOn {capture, html}`) mantém o Visible, o JavaScript e o JSON que já tinha. Eles saem
  em `preserved[]` e nunca são recusados.
- Num job parcial (`basedOn` + só o que mudou), o documento corrigido substitui o op do mesmo `<screen name>`
  (`job-patch.mjs`).

### Aceite medido (corpus do plano, 2026-10-11)

| Critério | Medido |
|---|---|
| Recriação: cada tela real lida pela C1 é recompilada pela forma documento numa cópia do módulo sem ela | **181 de 186 telas reais (97,3%)** voltam iguais: texto relido igual (chaves mapeadas por `k`) e nenhum erro novo no Verify. O11: 136/140 (97,1%); ODC: 45/46 (97,8%); 21.197 widgets |
| O resto, por causa | 3 Splash de template (`Horsie_UI`, `OfficePetMobile`, `SS360_Tech`): record literal no `OptionalConfigs` do ProgressBar, que o parser do O11 não lê (`HTML_RECORD_LITERAL`). `DCIPS_Staff_Common/DcipsLogin`: a instância de `LayoutDCIPSLogin` guarda conteúdo de um placeholder que o bloco não tem mais (`Header`). `FloodQuotes/PropertyCoverage`: `os-MarginTop="0"` de uma imagem volta vazio (o Model API do ODC não guarda margem 0 escrita numa imagem nova) |
| N nomes errados → 1 recusa com N problemas | 9 nomes errados (tipo, bloco, imagem, 3 destinos de evento, `bind` e 2 dentro de expressões) dão 1 recusa com 9 problemas, cada um com linha, coluna e os mais próximos; o documento corrigido vem no patch |
| Build ≤ 15 s na mediana | compilação da página (sem a mudança das actions, que só a prova paga): mediana de 0,88 s, p90 de 3,7 s e máximo de 10,5 s nas 186 telas. Um job de tela nova no `Haiku_UI` leva 10 s de ponta a ponta (carga, apply, Verify e gravação) |
| Os 274 jobs `html-fragment` e os 50 `html-page` de `C:\t\html-replay` mantêm o veredito | só duas mudanças alcançam esses jobs: as linhas novas de `ElementWidgetMap` (`switch`, `upload`, `button-group`, `i icon`) e as tags novas do fragmento. Os 14 jobs do corpus com essas tags, mais 13 do replay completo interrompido, rodaram na base `67231976` e nesta branch: **27 de 27 com o mesmo veredito**; 1 com a ordem das mensagens do Verify trocada. O replay completo dos 302 jobs não terminou: levaria cerca de 4 h por lado nesta máquina carregada |
| Ponto fixo da C1 com a ordem nova dos membros sem nome | 615 documentos de 27 módulos com 0 diferenças, 0 problemas e 0 não determinísticos (`html-check`) |

Testes:
- `kernel/tests/Anvil.Tests/ScreenDocumentTests.cs`: regras sem módulo, patch composto, tabela única, tela nova sobre a
  fixture e N nomes errados numa recusa; a fidelidade de 12/10/2026: as linhas com ligações, os `<style>` e o `data.css`
  colocados (e o `media` movido no patch), as classes de uma página e as regras de uma folha, a página do dono sobre a fixture
  (folha, ligações juntas, aviso de classe, ponto fixo) e o tema com o documento de chaves quebradas recusado inteiro.
- `ScreenRecreationTests` e `ScreenRecreationOdcTests` (`kernel/tests/Shared/ScreenRecreationCorpus.cs`): o corpus
  inteiro, com o piso de 95%, as causas conhecidas listadas em `corpus.json` (`recreation.known`) e a mediana do build. Sem
  as capturas, pulam com aviso.
- Fachada: `platforms/odc/facade/tests/patch-por-nome.test.mjs` (identidade do documento num job parcial).

## Telas padrão de entidades (gen-screen/1): a op `screen` com `data.generate`

Pedido do dono de 13/10/2026: o modelo gastava 70 a 82% do tempo escrevendo telas à mão (a sessão do `VisitaCerta_UI`:
36 min, 22 escritas, 13 recusadas). Lista, detalhe e formulário de uma entidade são uma família: o SSAM os gera, o modelo
não escreve nada além do pedido.

```json
{"op":"screen","data":{"generate":{"entities":["Customer","Order","Product"]}}}
```

Código: `kernel/src/Anvil.Core/Kernel/ScreenGenerator.cs` (o planejador, sem modelo: fatos → documentos e textos) e
`Verbs.ScreenGenerator.cs` (a leitura do módulo e a compilação). O gerador escreve documentos `ssam-html/1` e textos
`ssam-flow/1` e os compila pela forma documento desta op e pela op `logic`, num job interno (os blocos, depois as telas,
depois um op `logic` com todos os textos): as mesmas regras do dono, as mesmas checagens, o mesmo ponto fixo de uma página
que o modelo escreve. Os documentos nunca citam um ao outro: toda navegação é uma screen action com `navigate` no seu texto,
então compilam em qualquer ordem.

| Tela | O que tem |
|---|---|
| lista `<E>List` | `<table class="table">` com `<thead>` e `<tbody list>` (List nativa, nunca For Each nem cards); busca nos atributos de texto (`like`), um dropdown por referência a static; cabeçalhos ordenáveis (sort dinâmico, a referência ordena pelo rótulo do alvo); paginação; estados de erro (`HasFetchError`), carregando e vazio; link para o detalhe, editar e excluir com confirmação |
| detalhe `<E>Detail` | uma tabela de duas colunas (rótulo, valor; a referência mostra o rótulo do alvo pelo join); voltar, editar, excluir |
| formulário `<E>Edit` | um input por atributo, tipado (texto, textarea acima de 500, email, telefone, número, data, data e hora, checkbox), Max. Length do atributo, `required` do atributo, dropdown por referência; validações nativas (`BuiltInValidations`) e `if not Form.Valid` no Save |

- **Leitura:** aggregate da entidade (joins `With or Without` para os rótulos), ou action do módulo achada pela
  assinatura: lista da entidade com inputs de paginação (`start/offset/inicio`, `max/limit/limite`) e saída de total, lida
  por uma data action; registro por identificador (um input obrigatório `<E> Identifier`, uma saída `<E>`).
- **Escrita:** save achado pela assinatura (um input obrigatório que é o registro, verbo de save no nome) e delete (um
  input obrigatório identificador, sem saída de registro, verbo de delete no nome); sem eles, `Save<E>`/`Remove<E>` criadas
  uma vez em volta das entity actions. A tela nunca grava do cliente (o aviso de segurança do Studio bloqueia a entrega).
  Entidade só leitura sem save: lista e detalhe, sem formulário nem delete, e o recibo diz qual action expor (`gaps`).
- **Identificador:** o vazio segue o tipo do identificador (`NullTextIdentifier()` para um Id Text, também através de uma
  referência); um Id Text que a plataforma não numera é campo do formulário, habilitado só num registro novo; um Id que
  referencia outra entidade (extensão um para um) não é escolhido: o formulário edita os existentes e a lista não tem Novo
  (`GEN_SCREEN_ID_REFERENCE`).
- **Nomes:** os dados da tela (aggregate, data action) nunca tomam o nome de um elemento do módulo (uma server action
  `GetTicketList` tomaria o refresh do aggregate `GetTicketList` da tela): `Get<E>List`, senão `<E>ListData`.
- **Fluxo e papéis:** os do pedido (`flow`, `roles`), senão MainFlow e os papéis da maioria das telas do app que não são
  anônimas nem geradas (as geradas nunca votam na próxima execução), senão Registered (O11) ou usuários autenticados
  (ODC). No O11
  a plataforma guarda Registered num módulo com papéis próprios como Registered e todos eles; a forma documento passou a
  ler a coleção de novo depois de tirar o que sobra (antes, `roles="Registered"` nesse módulo saía sem papel nenhum, achado
  da AR2 no DCIPS_Staff_Cases).
- **Blocos:** layout (o mais usado pelas telas do app que não são anônimas; senão LayoutTopMenu), paginação, confirmação,
  barra de filtros e cabeçalho achados pela assinatura (inputs, eventos e placeholders, não o nome) no módulo ou nas
  referências; o papel que nenhum bloco faz vira um bloco criado uma vez (`Pager`, `ConfirmDialog`, `FilterBar`,
  `PageHeader`; `blocks:"inline"`: markup). `patterns:true` numa biblioteca cria só os blocos.
- **Regras do dono por construção:** sem JavaScript, sem Visible (If), sem For Each (List), dados por aggregate e data
  action, tabela, nenhum card; as 35 regras (OutSystems padrões, estágio oml) sem achado nos elementos gerados: descrição em
  toda action, input, saída, variável e aggregate, rótulo em todo assign, If como pergunta, booleanos `Is…`, actions
  Verbo+Objeto, tamanho da página literal (E3), uma chamada ao servidor por caminho (S2: depois do delete a linha sai da
  página no cliente, `ListIndexOf`/`ListRemove`). A regra `AGGREGATES_MERGEABLE` passou a não contar as opções de um Dropdown
  (uma lista de consulta, que um join perderia).
- **Idempotência:** toda raiz leva `ssam:gen-screen/1 <sha>` na descrição. O mesmo pedido sobre o módulo que ele produziu
  é `NO_CHANGE` (os blocos e as actions criados são achados pela assinatura). Raiz gerada e depois mudada: mantida e listada
  (`GEN_SCREEN_STALE`). Nome ocupado por algo não gerado: recusa com o patch do nome livre (`entities[].names`).
- **Recibo** (`results[].result.generate`): fluxo, papéis, layout, cada bloco (de onde veio), cada entidade (colunas,
  busca, filtros, campos, leitura, escrita), `create` (cada tela, bloco e action com bytes e sha), `unchanged`, `gaps`,
  `timings`; `emit:true` traz os textos.
- **Descoberta:** o cartão `html` do `ssam_code` traz a regra e a chamada de 3 linhas (`standardScreens`); a seção `text` do
  pacote de trabalho de uma tela nova traz `standard` com a entrega pronta.

### Medido (13/10/2026)

**10 telas, antes e depois.** Antes: a sessão do `VisitaCerta_UI` (12/10, análise em `C:\t\analise-vc-ui\ANALISE.md`), 4
telas à mão. Depois: lista, detalhe e formulário de Customer, Company e Product e a lista de Order sobre o fixture
`reactive-ui.oml` (o mesmo modelo do job de prova), CLI offline, sem worker.

| | à mão (4 telas) | `generate` (10 telas) |
|---|---|---|
| Bytes que o modelo escreve | 110 KB (47,7 KB de conversor JS, 48,4 KB em chamadas SSAM, 12,8 KB no navegador), ~27,5 KB por tela | **117 bytes** (89 com as 4 entidades inteiras) |
| O texto equivalente | — | 53.021 bytes de `ssam-html/1` e `ssam-flow/1` que o modelo teria de escrever, no mínimo |
| Escritas | 22 (13 recusadas, nenhuma com patch) | 1, aceita, 0 mensagens novas |
| Tempo | 36 min 22 s (73% do modelo) | 8,1 s na op (compilação 8,0 s), 17,7 s o CLI de ponta a ponta |
| Criado | 4 telas | 10 telas, 3 blocos (Pager, ConfirmDialog, FilterBar), 7 server actions (`Save<E>`, `Remove<E>`) |

**Corpus** (o deste plano, `C:\t\html-plan\unique.json`, sobre cópias): 3 entidades por módulo com 2 atributos ou mais além
do identificador, nunca static nem do System/Users/OutSystemsUI; primeiro as do módulo, as graváveis e as com referência.
16 módulos geram (12 O11, 4 ODC); 18 não: 5 de serviço, 1 Traditional, 1 biblioteca e 11 apps de UI sem 3 entidades
assim. Em todos: aceito, 0 mensagens novas, o ponto
fixo C1 em toda raiz gerada e em todo texto de fluxo, `compile-check` sem achado novo, sem JavaScript nem For Each, as 35
regras (estágio oml, O11) sem achado nos elementos gerados e a segunda execução `NO_CHANGE`. 182 elementos, 711 KB de texto
que o modelo não escreveu; compilação de 11 a 24 s por módulo.

| módulo | faixa | entidades | criados | bytes | novas msgs | ponto fixo telas / textos | compile-check | 35 regras | 2ª execução | gaps |
|---|---|---|---|---:|---:|---|---|---|---|---|
| Cardapio_BackOffice | o11 | Categoria, Endereco, GrupoAdicional | 9 | 31.290 | 0 | 9/9 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| Cardapio_UI | o11 | Endereco, GrupoAdicional, MovimentoCarteira | 9 | 39.060 | 0 | 9/9 / 25/25 | 0 | 0 | NO_CHANGE | NO_DELETE 3, NO_WRITE 2 |
| DCIPS_Staff_Admin | o11 | ApiIntegration, AppUser, AuditEntry | 9 | 41.105 | 0 | 9/9 / 28/28 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 2 |
| DCIPS_Staff_Cases | o11 | AuditEntry, Award, Benefit | 8 | 30.145 | 0 | 8/8 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| DCIPS_Staff_Common | o11 | AppUser, Case, CaseMessage | 8 | 39.397 | 0 | 8/8 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| DCIPS_Staff_Mortuary | o11 | AuditEntry, Case, CaseSecondaryTransfer | 8 | 38.116 | 0 | 8/8 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| DCIPS_Staff_PastConflicts | o11 | NaraRecordOrder, PastConflictFamilyMember, PastConflictGroup | 8 | 33.256 | 0 | 8/8 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| DCIPS_Staff_Reporting | o11 | AppUser, Case, Casualty | 8 | 45.320 | 0 | 8/8 / 20/20 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 3 |
| DCIPS_Staff_Reports | o11 | KbArticle, MetricSchedule, ReportSchedule | 9 | 41.915 | 0 | 9/9 / 34/34 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 1 |
| GameStore_UI ¹ | o11 | CoinTransaction, Game, Promotion | 10 | 36.105 | 0 | 10/10 / 34/34 | 0 | 0 | NO_CHANGE | NO_WRITE 3, NO_DELETE 1 |
| Horsie_UI | o11 | DiscoveryPreference, Horse, Match | 11 | 52.058 | 0 | 11/11 / 30/30 | 0 | 0 | NO_CHANGE | NO_DELETE 3, NO_WRITE 1 |
| OfficePet | o11 | Mission, Player, FallbackLine | 12 | 47.023 | 0 | 12/12 / 44/44 | 0 | 0 | NO_CHANGE | NO_WRITE 1, NO_DELETE 1 |
| EscalaViva | odc | Colaborador, Turno, Escala | 18 | 55.056 | 0 | 12/12 / 61/61 | 0 | — | NO_CHANGE | — |
| FloodQuotes | odc | QuestionDefault, Carrier, CarrierBulletPoint | 18 | 55.203 | 0 | 12/12 / 60/60 | 0 | — | NO_CHANGE | ID_REFERENCE 1 |
| insurance-reactive | odc | MockPropertyFixture, CSApplication, CSCommand | 18 | 68.750 | 0 | 12/12 / 59/59 | 0 | — | NO_CHANGE | — |
| QuizLiveWeb | odc | Pergunta, Partida, Resposta | 19 | 57.133 | 0 | 13/13 / 59/59 | 0 | — | NO_CHANGE | — |

¹ `GameDetail` já existia e não era gerada: a recusa (`GEN_SCREEN_NAME_TAKEN`) trouxe o patch do nome livre, aplicado como
veio (uma rodada a mais, sem escrever nada). `NO_WRITE`/`NO_DELETE`: entidade de um produtor exposta só para leitura e sem
save/delete achado pela assinatura; a entidade ganha lista e detalhe, sem formulário nem excluir, e o recibo diz qual action
expor. As 35 regras não foram checadas na faixa ODC (o estágio oml lê O11).

Testes: `ScreenGeneratorTests` (planejador sem Studio; com o Studio, os jobs de prova, o ponto fixo, o `NO_CHANGE` e a
renderização offline da lista pelo renderer do importador: tabela, linhas, paginação, nenhum card),
`ScreenGeneratorOdcTests`, `ScreenGeneratorCorpus` (as duas faixas sobre o corpus deste plano, com
`SSAM_GEN_SCREEN_CORPUS=1`), `platforms/odc/facade/tests/gen-screen-card.test.mjs`.

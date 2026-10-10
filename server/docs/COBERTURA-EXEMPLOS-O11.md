# Cobertura de exemplos provados: faixa O11

Data: 2026-10-07. Branch `exemplos/o11`, base `25e161bb`.

Este documento mede quantos widgets, padrões e capacidades do O11 têm um exemplo provado.
Exemplo provado é um job que passa pelo kernel e pelo Verify da versão atual, sobre um fixture.
Ele roda na bateria de testes, então nunca vira conselho velho.

A matriz legível por máquina é `kernel/tests/jobs/examples/matriz.json`.
Os exemplos novos estão em `kernel/tests/jobs/examples/`.

## 1. Níveis

- **minimal**: o menor job válido. Uma tela existente recebe o elemento com o que ele exige.
- **typical**: dado, evento e ligação. Ex.: aggregate, `OnChange` que refaz a consulta, variável ligada.
- **rich**: uma tela inteira ou um cenário completo, em várias partes sobre o mesmo módulo.

Estados de cada linha da matriz:

- `proven-existing`: já havia um job da suíte `kernel/tests/jobs` que prova o caso.
- `new`: exemplo novo deste pacote, em `kernel/tests/jobs/examples`.
- `blocked`: o kernel recusa sem Studio, ou o caso não é mudança de módulo. O motivo está em `notes`.

Linhas sem job ficam em `pending`, com `state`:
`todo` (falta escrever) ou `not-applicable` (o mínimo já é o uso típico).

## 2. Como rodar

- Um exemplo: `dotnet .local/cli/anvil.dll apply --job tests/jobs/examples/<job>.json --out <arquivo>.oml`.
- Todos: `dotnet test tests/Anvil.Tests --filter FullyQualifiedName~ExamplesO11Tests`.
- A classe `ExamplesO11Tests` aplica cada job como `JobTests` faz com `tests/jobs`.
- O teste `MatrixAndExamplesAgree` recusa job citado que não existe e exemplo que a matriz não cita.
- A suíte antiga (`JobTests`) não lê subpastas. Por isso os exemplos têm a classe própria.

Os exemplos de widget usam `base: "job:ex-base"`.
`ex-base` cria a tela `Showcase` (LayoutTopMenu) e os dados `Task` e `Priority`.
Assim o exemplo mostra só os ops do widget.
Três blocos só existem no template Mobile: eles usam `ex-base-mobile` (bloco `Layout`, placeholder `Content`).

## 3. Resumo antes e depois

Contagem por id (um id coberto quando ao menos uma linha tem job).

| Tipo | Ids | Com exemplo antes | Com exemplo depois | Bloqueados |
|---|---|---|---|---|
| Capacidade (catálogo do discover, faixa o11) | 56 | 45 | 49 | 7 |
| Widget nativo (Reactive/Mobile 31, Traditional 24) | 55 | 54 | 55 | 0 |
| Padrão (OutSystems UI 84, padrões de sessão 13, CRUD 6) | 103 | 27 | 102 | 1 |

Por nível (ids com job / ids do nível):

| Tipo | minimal antes → depois | typical antes → depois | rich antes → depois |
|---|---|---|---|
| Capacidade | 43 → 48 de 56 | 39 → 48 de 56 | — |
| Widget | 54 → 55 de 55 | 15 → 36 de 55 | — |
| Padrão | 27 → 96 de 97 | 11 → 89 de 94 | 0 → 6 de 6 |

"Antes" conta só as linhas que apontam para um job da suíte. A preparation tinha prova (o CRUD
Traditional), mas não um exemplo mínimo: por isso o mínimo dela entra como novo.

Arquivos novos: 167 jobs. Por nível: 71 minimal, 88 typical, 6 rich e 2 bases.

## 4. Capacidades só declaradas (prioridade a)

Onze capacidades da faixa o11 não tinham prova no catálogo.

| Capacidade | Resultado | Jobs ou motivo |
|---|---|---|
| `ui.dropdown-search` | novo | `cap-dropdown-search-minimal`, `cap-dropdown-search-typical` (opções montadas de uma static no OnAfterFetch) |
| `read.inspect` | novo | `cap-read-inspect-minimal` (find, get), `cap-read-inspect-typical` (find, dump, get, usages). Prova os verbos de leitura do kernel; `ssam_map`/`o11_inspect` continuam a rota viva |
| `diagnostic.troubleshoot` | novo | `cap-diagnostic-minimal` (aviso declarado, `matched`), `cap-diagnostic-typical` (erro reproduzido, `expectValid: false`) |
| `deliver.job` | novo | `cap-deliver-job-minimal` (forma mínima), `cap-deliver-job-typical` (job composto `jobs`, uma transação) |
| `integration.rest-import` | bloqueado | Recusa do kernel: `INTEGRATION_IMPORT_NEEDS_STUDIO` em `/data/openapi`. O importador O11 roda no Studio, pela bridge, dentro do `o11_deliver` |
| `integration.soap` | bloqueado | Recusa do kernel: `INTEGRATION_IMPORT_NEEDS_STUDIO` em `/data/methods`. Mesma razão |
| `integration.dotnet-extension-o11` | bloqueado | `o11_extension` publica pelo Service Center: precisa de rede e da sessão do Studio |
| `read.discover` | bloqueado | Ferramenta, não muda módulo |
| `data.records` | bloqueado | Dados do ambiente (`o11_data`), não roda headless |
| `ops.debugger` | bloqueado | Depurador do runtime publicado |
| `ops.environment` | bloqueado | `ssam_doctor`, ferramenta operacional |

As duas recusas de importação são o desenho atual, não defeito: o kernel avisa antes de mudar.

Além das onze: `cap-client-variable-typical` (client variable lida e escrita pela tela)
e `cap-preparation-minimal` (preparation de tela Traditional).

## 5. Padrões das sessões reais (prioridade b)

Padrões que as sessões reais de clientes enfrentaram (06 e 07/10).

| Padrão | Job | O que mostra |
|---|---|---|
| Lista com filtro e paginação | `pat-list-filter-pagination` | aggregate com `StartIndex`/`MaxRecords`, pesquisa, Dropdown de static, Table, Pagination e `OnNavigate`; filtro novo volta à página 1 |
| Formulário com validação e gravação | `pat-form-validation-save` | server action com `create` ou `update` do record, validação no servidor; no cliente `Valid`/`ValidationMessage` e chamada só com `Form.Valid`, record como expressão |
| Mestre-detalhe | `pat-master-detail` | Columns2, Link com argumento, Refresh Data das linhas, If enquanto nada foi escolhido |
| Produtor com action pública | `pat-producer-public-action` | entidade, structure e server action públicas |
| Consumidor por referência | `pat-consumer-reference-action` | op `reference` e chamada pelo nome; ao vivo `producer` é o nome do módulo, com `captureProducers: ["<Módulo>"]` |
| Static num Dropdown | `pat-static-dropdown` | registros pela spec, aggregate ordenado, `Entities.X.Y` no OnInitialize |
| Timer | `pat-timer-typical` | action que trabalha em lote e `Schedule` "Every day at 02:00" |
| Role na tela | `pat-role-check-screen` | `Roles` da tela, `CheckApproverRole` no OnInitialize e no servidor, If no lugar de Visible |
| Button Group | `pat-osui-buttongroup` | no Reactive O11 o Button Group do OutSystems UI é o widget nativo `IButtonGroup`; `OnChange` refaz a consulta |
| Tabs | `pat-osui-tabs` | aba ativa em variável e `OnTabChange` |
| Tela anônima | `pat-anonymous-screen` | um `set Roles` por tela com a lista inteira: `[Anonymous, Registered]` ou `[Registered]` |

Lições que os jobs registram:

- Numa expressão de tela Reactive, `CheckXRole(GetUserId())` não existe (`ExpressionUnknownFunction`).
  No cliente chame a action `CheckXRole` e guarde `HasRole` numa variável. No servidor a função vale.
- Record literal (`Entity{Campo: valor}`) não é expressão válida em `DefaultValue`. Use o OnInitialize.
- `ISort` não aceita `args`: crie sem args e faça `set Attribute` e `set SortDirection`.
- No Dropdown o texto vazio é `EmptyValue`.
- `AddDays(CurrDate(), n)` devolve Date Time: compare com `DateTimeToDate(...)`.
- Nome de entidade pode colidir com structure referenciada (`Attachment` do OutSystems UI). O kernel recusa antes.
- Na spec de lógica, o `DataSource` do `IRefreshDataNode` é `IScreenAggregate:<Nome>`.
- A List avisa quando tem mais de um filho direto: envolva num Container.

## 6. Cenário rico (prioridade c)

CRUD back-office, tabela primeiro, sem cards nem tiles.

| Parte | Job | Conteúdo |
|---|---|---|
| 1 | `crud-01-data` | static `ProductCategory`, `Product` com índice único, role `ProductManager`, exceções |
| 2 | `crud-02-logic` | `Product_Save` (role, validação, código repetido, create ou update) e `Product_Delete` |
| 3 | `crud-03-screens` | `ProductList` e `ProductEdit` criadas antes, para as navegações existirem |
| 4 | `crud-04-edit` | Form, Labels ligados, Dropdown, validação no cliente, handler de `ProductInvalid`, volta à lista |
| 5 | `crud-05-list` | pesquisa, filtro, join com a static, paginação, Link para editar, apagar com confirmação num Popup nativo |
| tudo | `crud-all` | as cinco partes numa transação (um merge na entrega), sem avisos |

Cada parte declara os avisos transitórios (action ainda sem chamador, input ainda sem uso).

## 7. Widgets e padrões restantes (prioridade d)

- Widgets nativos: 30 dos 31 do Reactive/Mobile já tinham mínimo (`gallery-native-reactive` e outros).
  O ListItemAction ganhou o seu (`wid-listitemaction-minimal`).
  Agora 30 têm típico. O Text estático não tem dado nem evento.
- OutSystems UI 2.28.1: 84 blocos públicos. 126 jobs gerados a partir de `catalog/ui/OutSystemsUI-2.28.1.json`.
  - mínimo: o bloco como o Studio cria ao arrastar, com inputs e eventos obrigatórios;
  - típico: inputs em variáveis, placeholders com dados do aggregate, todos os eventos tratados
    por screen actions que guardam os parâmetros;
  - itens (WizardItem, BreadcrumbsItem, SectionIndexItem, FloatingActionsItem, AccordionItem) ficam dentro do pai vazio;
  - blocos cujo conteúdo de exemplo depende do template nascem vazios (`"empty": true`):
    MasterDetail, StackedCards, DropdownServerSide, DropdownServerSideItem, OverflowMenu, Submenu, SectionIndex,
    ProgressCircle e Wizard. Arrastados com o conteúdo de exemplo, eles dão erro no Verify
    (List sem Source, Link sem OnClick, expressão sobre variável do template);
  - ButtonLoading: o Button de exemplo precisa de OnClick. LightboxImage: a Image de exemplo precisa de origem.
- `SwipeEvents` está bloqueado: nenhum fixture o referencia, e o produtor OutSystemsUI não está versionado.

## 8. O que falta

- `logic.app-event`: falta o mínimo (a única prova, `cat-b-app-events`, é rica).
- 18 widgets Traditional sem típico (CheckBox, ComboBox, RadioButton, InputPassword, InputFilename,
  ListRecords, EditRecord, ShowRecord, Table, Row, Cell, Text, If, EditableTable, EditableTableCell,
  Form, Label, WebBlockInstance). Todos têm mínimo provado (`cat-b-traditional-gallery`, `osui-web-patterns`).
- OutSystems UI Web (Traditional), OutSystemsCharts e OutSystemsMaps: fora desta rodada.
- Servidos desde o ramo `distribuicao/exemplos`: o índice do discover lê `kernel/tests/jobs/examples` como `examples/<job>`
  (resultados em `.local/test-work/examples`), o catálogo aceita `examples/<job>` nas provas e o
  `ssam_reference {kind:"example"}` lista e resolve os exemplos e a matriz (`id: "matriz"`).

## 9. Recusas do kernel que parecem defeito

- `LOGIC_INVALID` do `IRefreshDataNode` com `DataSource` sem tipo (`"GetTicketPage"`):
  a mensagem certa vem quatro vezes (no ponteiro da action e no do passo, duas vezes cada),
  e o `fix` anexado é de outra regra ("use each declared input and var in an expression...").
  Reproduzir: em `pat-list-filter-pagination`, troque `IScreenAggregate:GetTicketPage` por `GetTicketPage`.
- Nenhuma outra recusa do kernel nesta rodada pareceu defeito.
  As demais foram erros do job (corrigidos no job) ou recusas de desenho (seção 4).

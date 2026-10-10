# Cobertura de exemplos provados — faixa ODC

Data: 2026-10-07. Ramo `exemplos/odc`.

## O que é

Cada widget nativo, cada padrão de UI e cada capacidade do discover na faixa ODC tem uma linha na matriz.
Cada linha aponta um job de exemplo **provado**: ele passa no kernel e no Verify do release atual.
Um exemplo provado nunca vira conselho velho: o teste roda de novo a cada bateria.

- Exemplos: `kernel/tests/jobs-odc/examples/*.json` (251 jobs).
- Matriz de máquina: `kernel/tests/jobs-odc/examples/matriz.json`.
- Gerador da matriz: `node scripts/examples-odc-matrix.mjs` (com `--check` só confere se ela está em dia).
- Teste: `kernel/tests/Anvil.Tests.Odc/ExamplesOdcTests.cs`.

## Como rodar

```
dotnet test kernel\tests\Anvil.Tests.Odc -c Release --filter "FullyQualifiedName~ExamplesOdcTests"
```

O teste aplica cada job como `OdcJobTests.JobAppliesAndVerifies`: kernel, Verify, contrato de mensagens, OML de saída.
O resultado vai para `kernel/.local/lane-odc/test-work/examples/<job>.result.json`, com o carimbo de proveniência.
Um `blocked-*.json` declara `expectError`: o teste prova a recusa exata de hoje.
Se o kernel passar a aceitar, o teste falha e a linha da matriz deixa de ser `blocked`.
O teste também confere a descrição de uma linha, as regras de plataforma do ODC e a matriz.
Tempo medido: cerca de 6 s por job no processo de teste; a classe inteira leva por volta de 30 min.

## Regras dos exemplos

- Base: o fixture `kernel/tests/fixtures/odc/insurance-reactive-r8.oml` (app Reactive com OutSystemsUI, Charts e Maps), o fixture da faixa ODC anonimizado: o mesmo módulo de cliente com todo nome de cliente trocado por um neutro (`InsuranceApp`) pelas ops `rename`/`set` do próprio kernel (`scripts/anonymize-odc-fixture.mjs`).
- Cada job é pequeno, autossuficiente e tem uma `description` de uma linha em pt-BR.
- `minimal`: o menor job que passa (a tela de apoio mais o elemento e o que ele exige).
- `typical`: dados + evento + binding (variável, aggregate ou data action, handler com argumento).
- `rich`: o fluxo da loja (`ecommerce-01-data` a `ecommerce-04-catalog`, encadeados por `job:`) e o composto `ecommerce-all`, que entrega tudo numa transação.
- `_why` nos ops explica o que não é óbvio. Ícones sempre com `Weight`.

## Resumo

| tipo | linhas | cobertas antes | cobertas depois |
|---|---|---|---|
| widget | 66 | 52 | 65 |
| pattern | 222 | 2 | 216 |
| capability | 148 | 91 | 113 |

"Coberta" = status `new` ou `proven-existing`. "Antes" = havia job da suíte `tests/jobs-odc` para a linha.
Status das 436 linhas: 303 `new`, 91 `proven-existing`, 36 `blocked`, 6 `pending`.

Exemplos novos por nível: 133 minimal, 110 typical, 5 rich (loja), 3 de recusa (`blocked-*`).
Por grupo: 11 padrões de uso da loja, 8 capacidades, 40 widgets, 150 OutSystemsUI, 20 Charts, 14 Maps, 5 loja, 3 recusas.

## As 17 capacidades só declaradas

O catálogo tinha 17 capacidades da faixa ODC sem nenhuma prova.

- Com exemplo novo (minimal e typical): `ui.screen-spec`, `ui.html-page`, `ui.dropdown-search`, `read.inspect`.
- `read.inspect`: o exemplo prova a leitura dentro de um job (`find`, `get`, `usages`, `dump`). A rota viva `ssam_map`/`studio_inspect` continua sem prova.
- `ui.screen-spec`: `table`, `detail`, `form` e `dashboard` passam. O `kind: cards` falha (defeito 1).
- Bloqueadas com recusa provada: `reference.external-library-odc` (`blocked-reference-external-library`).
- Bloqueadas por não serem op de job: `integration.external-library-odc`, `read.discover`, `deliver.job`, `deliver.feature`, `deliver.publish`, `data.records`, `ops.references-refresh`, `ops.studio-session`, `ops.portal`, `ops.debugger`, `ops.environment`, `diagnostic.troubleshoot`. São rotas vivas (Studio, Portal, rede) ou leitores. O motivo de cada uma está em `notes`.

## Padrões que um usuário real precisou (loja, 2026-10-06)

| padrão | exemplo | o ponto |
|---|---|---|
| Gallery com List de data action | `usage-gallery-data-action-typical` | a Gallery nasce com uma List de exemplo sem Source: `empty: true` |
| card clicável com argumento | `usage-clickable-card-minimal`, `-typical` | `create IEvent` no Container, `Event onclick`, `Handler` = screen action, argumento `$ev/<Input>` |
| link com ícone e texto | `usage-link-icon-text-minimal`, `-typical` | apague o `#ITextWidget` do Link; Icon (com Weight) e Expression dentro dele |
| imagem externa | `usage-external-image-minimal`, `-typical` | `Type External` + `Url` (expressão); `DefaultImage` para falha |
| linha de carrinho com - e + | `usage-cart-line-quantity-typical` | `List.CurrentRowNumber` no argumento; `Assign GetX.List[RowIndex].E.Attr` e o resumo da saída da server action; sem Refresh Data |
| filtro por categoria | `usage-category-filter-typical` | Dropdown sobre a static entity; OnChange com Refresh Data; filtro `Var = NullIdentifier() or ...` |
| navegação com input | `usage-navigation-input-minimal`, `-typical` | `$btn/OnClick Destination` + `$btn/OnClick/<Input> Value` |

## Armadilhas provadas (o que os exemplos ensinam)

- Gallery, Carousel, MasterDetail e StackedCards nascem com uma List de exemplo sem Source: use `empty: true`.
- OverflowMenu, Submenu, SectionIndex, DropdownServerSide(Item) e ProgressCircle também nascem com exemplo inválido: `empty: true`.
- DatePicker, DatePickerRange, MonthPicker, TimePicker, Search, InputWithIcon e AnimatedLabel trazem um Input de exemplo: `set $b/<Placeholder>/#IInput Variable`.
- Tabs e Accordion nascem com três itens válidos; para os seus itens, `empty: true` e crie `TabsHeaderItem`/`TabsContentItem`/`AccordionItem`.
- O handler de um evento estendido (`IEvent`) tem de ser uma screen action. A tela direto é recusada pela plataforma.
- O handler de evento de bloco pode ter inputs com outros nomes: o argumento é expressão sobre os parâmetros do evento.
- Um input do handler com o nome de uma variável da tela gera `Assign X = X`, que o kernel recusa.
- Aggregate com o nome padrão `Get<Entidade>s` é renomeado quando ganha um filtro simples: use outro nome (`LoadTickets`).
- Filhos de um HTML Element (`IAdvancedHtml`) vão em `$html/Content`.
- `DefaultValue` de variável só aceita literal (`#2026-01-01#`, não `CurrDate()`).
- Texto OutSystems não usa barra invertida: aspas internas viram aspas simples dentro do HTML/SVG.
- `IUpload.Accept` é enum: `Image`, `Video` ou `Any`. `Size()` exige `File`, não `Binary Data`.
- Inputs de static entity do OSUI: `Entities.<Entidade>.<Registro>` (`Entities.Color.Primary`).
- Settings só existem no servidor: leia a chave numa data action (`maps-map-typical`).
- `Polygon`/`Polyline.Locations` é `Text List`: `["lat, lng", ...]`.
- O Button Group nativo funciona pelos verbos no ODC: os itens nascem com o grupo e mantêm o `Value` depois de salvar e recarregar o OML.

## Defeitos do kernel encontrados (não corrigidos aqui)

1. **`op screen` com `kind: cards` falha no ODC.** Recusa: `screen op #N (create ): InvalidOperationException: Sequence contains no elements`. A pilha termina em `ServiceStudio.Plugin.NRWidgets.List.GetContent()` (`Single()` sem IContent). O expansor esvazia a List de exemplo da Gallery; no ODC o IContent sai junto. `table`, `detail`, `form` e `dashboard` sem card passam. Job: `blocked-screen-spec-cards`.
2. **A recusa de referência a External Library na faixa ODC ensina o caminho da O11.** Texto: `producer SSAMTextTools not bound: o11_deliver binds a producer by its name (captureProducers:[...])`. No ODC o caminho é `studio_deliver` com a assinatura capturada pela bridge (`reference-snapshot`). Job: `blocked-reference-external-library`.
3. **Dica sem relação numa escrita recusada pela plataforma.** `set Handler` de um `IEvent` com uma tela devolve `... cannot be used as the value for the ... IEvent.Handler property ... For a DataType change on a foreign key, clear the DefaultValue and remove the consumers first, or replace the attribute by a new one`. A segunda frase não tem nada a ver com o erro.
4. **Ícone sem `Weight` passa nos verbos crus.** O Verify headless aceita; o Studio recusa (`html-visual` já exige `weight`). Nenhuma regra de preflight avisa no `create IIcon`.

## Catálogo desatualizado (para o integrador)

- `ui.html-page`: `html-if-links` (suíte) já usa a op `html` de página inteira no ODC; o catálogo diz que não há job.
- Ausências declaradas que a suíte ou os exemplos contrariam: `button-group-native` (os exemplos `widget-button-group-*`; o limite era da rota C#), `ai.agents` (`agent-calls`, `agent-definition-tools`), `ai.semantic-search` (`logic-semantic-search`, `semantic-search-attributes`), `event.global-events` (`global-event-unused`), `process.odc-workflow` (`workflow-nodes`), `module-image` (`image-create`).
- `ui.widget`: o limite "IIfWidget, ILink e Image sem job ODC" já não vale (`cat-b-widget-gallery`).
- `ui.dropdown-search` e `ui.screen-spec`: os limites "nenhum job ODC" agora têm exemplos.

## Integração (ramo `distribuicao/exemplos`)

- O discover serve os exemplos: `discovery.mjs` (`loadJobs`/`loadNegatives`) lê `kernel/tests/jobs-odc/examples` como `examples/<job>` e os resultados em `.local/lane-odc/test-work/examples/`; os `blocked-*` entram como recusas provadas.
- Os fragmentos do catálogo citam os exemplos em `platforms.odc.proofs` (`examples/<job>`) onde a matriz diz que eles provam a capacidade.
- `ssam_reference {kind:"example"}` lista e resolve os exemplos (`jobs-odc/examples/<job>` ou só o nome) e a matriz (`id: "matriz"`), que aponta este documento.
- `PacoteEOdcRulesTests` varre só o nível de cima; `ExamplesOdcTests` aplica as mesmas regras de plataforma aos exemplos.
- Distribuição: o fixture é neutro, os exemplos vão na imagem hospedada (`docker/ssam-server`); o guarda `platforms/odc/facade/tests/hosted-image-denylist.test.mjs` confere que nada do que vai nela nomeia cliente.
## Verificação desta rodada

- `ExamplesOdcTests`: 504 testes aprovados (251 jobs aplicados + 251 descrições + regras + matriz), cerca de 29 min.
- Suíte ODC existente (`Anvil.Tests.Odc` sem os exemplos), uma vez: 248 aprovados, 1 ignorado que já era ignorado (`ExternalLibraryProducerIsImportedIntoAConsumerCandidate`), 0 falhas. `Pa2F2OdcTests.NoNewRuleFiresOnTheRepositoryOdcJobs`, que varre as subpastas, passou com os exemplos.
- `Anvil.Tests` (faixa O11) `GuideTests` e `SurfaceTests`, que varrem `tests/jobs*` com subpastas: 35 aprovados.
- `node scripts/examples-odc-matrix.mjs --check`: matriz em dia.

## O que ficou pendente

- OutSystemsMaps: `DrawMarker` (minimal e typical) e o typical de `FileLayer`, `Polyline`, `SearchPlaces` e `StaticMap`.
- Nenhum widget nem padrão do OutSystemsUI ficou sem exemplo.

## Tabelas (geradas da matriz)

Legenda: `novo` = exemplo desta pasta; `suite` = job de `tests/jobs-odc` que já cobria; `bloqueado` e `pendente`: motivo em `notes` da matriz.

### Widgets nativos (33)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| widget.block-instance | novo: `osui-card-minimal` | novo: `osui-pagination-typical` | - | sim |
| widget.button | novo: `widget-button-minimal` | novo: `widget-button-typical` | - | sim |
| widget.button-group | novo: `widget-button-group-minimal` | novo: `widget-button-group-typical` | - | nao |
| widget.button-group-item | novo: `widget-button-group-minimal` | novo: `widget-button-group-typical` | - | nao |
| widget.checkbox | novo: `widget-checkbox-minimal` | novo: `widget-checkbox-typical` | - | sim |
| widget.container | novo: `widget-container-minimal` | novo: `widget-container-typical` | - | sim |
| widget.dropdown | novo: `widget-dropdown-minimal` | novo: `usage-category-filter-typical` | - | sim |
| widget.editable-table | bloqueado | - | - | nao |
| widget.expression | novo: `widget-expression-minimal` | novo: `usage-gallery-data-action-typical` | - | sim |
| widget.extended-event | novo: `usage-clickable-card-minimal` | novo: `usage-clickable-card-typical` | - | sim |
| widget.form | novo: `widget-form-minimal` | novo: `widget-form-typical` | - | sim |
| widget.header-cell | novo: `widget-table-minimal` | novo: `widget-table-typical` | - | sim |
| widget.html-element | novo: `widget-html-element-minimal` | novo: `widget-html-element-typical` | - | sim |
| widget.icon | novo: `widget-icon-minimal` | novo: `usage-link-icon-text-typical` | - | sim |
| widget.if | novo: `widget-if-minimal` | novo: `widget-if-typical` | - | sim |
| widget.image | novo: `usage-external-image-minimal` | novo: `usage-external-image-typical` | - | sim |
| widget.input | novo: `widget-input-minimal` | novo: `widget-input-typical` | - | sim |
| widget.label | novo: `widget-label-minimal` | novo: `widget-form-typical` | - | sim |
| widget.link | novo: `usage-link-icon-text-minimal` | novo: `usage-link-icon-text-typical` | - | sim |
| widget.list | novo: `widget-list-minimal` | novo: `usage-gallery-data-action-typical` | - | sim |
| widget.list-item | novo: `widget-list-item-minimal` | novo: `usage-navigation-input-typical` | - | sim |
| widget.list-item-action | novo: `widget-list-item-action-minimal` | novo: `widget-list-item-action-typical` | - | nao |
| widget.placeholder | novo: `widget-placeholder-minimal` | suite: `block-reuse` | - | sim |
| widget.popover | novo: `widget-popover-minimal` | suite: `email-popover-metadata` | - | sim |
| widget.popup | novo: `widget-popup-minimal` | novo: `widget-popup-typical` | - | sim |
| widget.radio-button | novo: `widget-radio-group-minimal` | novo: `widget-radio-group-typical` | - | sim |
| widget.radio-group | novo: `widget-radio-group-minimal` | novo: `widget-radio-group-typical` | - | sim |
| widget.row-cell | novo: `widget-table-minimal` | novo: `widget-table-typical` | - | sim |
| widget.switch | novo: `widget-switch-minimal` | novo: `widget-switch-typical` | - | sim |
| widget.table | novo: `widget-table-minimal` | novo: `widget-table-typical` | novo: `ecommerce-02-cart` | sim |
| widget.text | novo: `widget-text-minimal` | novo: `widget-text-typical` | - | sim |
| widget.text-area | novo: `widget-text-area-minimal` | novo: `widget-text-area-typical` | - | sim |
| widget.upload | novo: `widget-upload-minimal` | novo: `widget-upload-typical` | - | sim |

### Padroes do OutSystems UI (79)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| osui.Accordion | novo: `osui-accordion-minimal` | novo: `osui-accordion-typical` | - | nao |
| osui.AccordionItem | novo: `osui-accordion-item-minimal` | novo: `osui-accordion-item-typical` | - | nao |
| osui.ActionSheet | novo: `osui-action-sheet-minimal` | novo: `osui-action-sheet-typical` | - | nao |
| osui.Alert | novo: `osui-alert-minimal` | novo: `osui-alert-typical` | - | nao |
| osui.AlignCenter | novo: `osui-align-center-minimal` | novo: `osui-align-center-typical` | - | nao |
| osui.Animate | novo: `osui-animate-minimal` | novo: `osui-animate-typical` | - | nao |
| osui.AnimatedLabel | novo: `osui-animated-label-minimal` | novo: `osui-animated-label-typical` | - | nao |
| osui.Badge | novo: `osui-badge-minimal` | novo: `osui-badge-typical` | - | nao |
| osui.BlankSlate | novo: `osui-blank-slate-minimal` | novo: `osui-blank-slate-typical` | - | nao |
| osui.Breadcrumbs | novo: `osui-breadcrumbs-minimal` | novo: `osui-breadcrumbs-typical` | - | nao |
| osui.BreadcrumbsItem | novo: `osui-breadcrumbs-item-minimal` | novo: `osui-breadcrumbs-typical` | - | nao |
| osui.ButtonLoading | novo: `osui-button-loading-minimal` | novo: `osui-button-loading-typical` | - | nao |
| osui.Card | novo: `osui-card-minimal` | novo: `osui-card-typical` | - | nao |
| osui.CardBackground | novo: `osui-card-background-minimal` | novo: `osui-card-background-typical` | - | nao |
| osui.CardItem | novo: `osui-card-item-minimal` | novo: `osui-card-item-typical` | - | nao |
| osui.CardSectioned | novo: `osui-card-sectioned-minimal` | novo: `osui-card-sectioned-typical` | - | nao |
| osui.Carousel | novo: `osui-carousel-minimal` | novo: `osui-carousel-typical` | - | nao |
| osui.CenterContent | novo: `osui-center-content-minimal` | novo: `osui-center-content-typical` | - | nao |
| osui.ChatMessage | novo: `osui-chat-message-minimal` | novo: `osui-chat-message-typical` | - | nao |
| osui.Columns2 | novo: `osui-columns2-minimal` | novo: `osui-columns2-typical` | - | nao |
| osui.Columns3 | novo: `osui-columns3-minimal` | novo: `osui-columns3-typical` | - | nao |
| osui.Columns4 | novo: `osui-columns4-minimal` | novo: `osui-columns4-typical` | - | nao |
| osui.Columns5 | novo: `osui-columns5-minimal` | novo: `osui-columns5-typical` | - | nao |
| osui.Columns6 | novo: `osui-columns6-minimal` | novo: `osui-columns6-typical` | - | nao |
| osui.ColumnsMediumLeft | novo: `osui-columns-medium-left-minimal` | novo: `osui-columns-medium-left-typical` | - | nao |
| osui.ColumnsMediumRight | novo: `osui-columns-medium-right-minimal` | novo: `osui-columns-medium-right-typical` | - | nao |
| osui.ColumnsSmallLeft | novo: `osui-columns-small-left-minimal` | novo: `osui-columns-small-left-typical` | - | nao |
| osui.ColumnsSmallRight | novo: `osui-columns-small-right-minimal` | novo: `osui-columns-small-right-typical` | - | nao |
| osui.Counter | novo: `osui-counter-minimal` | novo: `osui-counter-typical` | - | nao |
| osui.DatePicker | novo: `osui-date-picker-minimal` | novo: `osui-date-picker-typical` | - | sim |
| osui.DatePickerRange | novo: `osui-date-picker-range-minimal` | novo: `osui-date-picker-range-typical` | - | nao |
| osui.DisplayOnDevice | novo: `osui-display-on-device-minimal` | novo: `osui-display-on-device-typical` | - | nao |
| osui.DropdownSearch | novo: `cap-dropdown-search-minimal` | novo: `cap-dropdown-search-typical` | - | nao |
| osui.DropdownServerSide | novo: `osui-dropdown-server-side-minimal` | novo: `osui-dropdown-server-side-typical` | - | nao |
| osui.DropdownServerSideItem | novo: `osui-dropdown-server-side-item-minimal` | novo: `osui-dropdown-server-side-typical` | - | nao |
| osui.DropdownTags | novo: `osui-dropdown-tags-minimal` | novo: `osui-dropdown-tags-typical` | - | nao |
| osui.FlipContent | novo: `osui-flip-content-minimal` | novo: `osui-flip-content-typical` | - | nao |
| osui.FloatingContent | novo: `osui-floating-content-minimal` | novo: `osui-floating-content-typical` | - | nao |
| osui.Gallery | novo: `osui-gallery-minimal` | novo: `usage-gallery-data-action-typical` | novo: `ecommerce-04-catalog` | nao |
| osui.IconBadge | novo: `osui-icon-badge-minimal` | novo: `osui-icon-badge-typical` | - | nao |
| osui.InlineSVG | novo: `osui-inline-svg-minimal` | novo: `osui-inline-svg-typical` | - | nao |
| osui.InputWithIcon | novo: `osui-input-with-icon-minimal` | novo: `osui-input-with-icon-typical` | - | nao |
| osui.Licenses | novo: `osui-licenses-minimal` | novo: `osui-licenses-typical` | - | nao |
| osui.LightboxImage | novo: `osui-lightbox-image-minimal` | novo: `osui-lightbox-image-typical` | - | nao |
| osui.ListItemContent | novo: `osui-list-item-content-minimal` | novo: `osui-list-item-content-typical` | - | nao |
| osui.MarginContainer | novo: `osui-margin-container-minimal` | novo: `osui-margin-container-typical` | - | nao |
| osui.MasterDetail | novo: `osui-master-detail-minimal` | novo: `osui-master-detail-typical` | - | nao |
| osui.MonthPicker | novo: `osui-month-picker-minimal` | novo: `osui-month-picker-typical` | - | nao |
| osui.MouseEvents | novo: `osui-mouse-events-minimal` | novo: `osui-mouse-events-typical` | - | nao |
| osui.Notification | novo: `osui-notification-minimal` | novo: `osui-notification-typical` | - | nao |
| osui.OverflowMenu | novo: `osui-overflow-menu-minimal` | novo: `osui-overflow-menu-typical` | - | nao |
| osui.Pagination | novo: `osui-pagination-minimal` | novo: `osui-pagination-typical` | - | nao |
| osui.PasswordPolicy | novo: `osui-password-policy-minimal` | novo: `osui-password-policy-typical` | - | nao |
| osui.ProgressBar | novo: `osui-progress-bar-minimal` | novo: `osui-progress-bar-typical` | - | nao |
| osui.ProgressCircle | novo: `osui-progress-circle-minimal` | novo: `osui-progress-circle-typical` | - | nao |
| osui.ProviderLoginButton | novo: `osui-provider-login-button-minimal` | novo: `osui-provider-login-button-typical` | - | nao |
| osui.RangeSlider | novo: `osui-range-slider-minimal` | novo: `osui-range-slider-typical` | - | nao |
| osui.RangeSliderInterval | novo: `osui-range-slider-interval-minimal` | novo: `osui-range-slider-interval-typical` | - | nao |
| osui.Rating | novo: `osui-rating-minimal` | novo: `osui-rating-typical` | - | nao |
| osui.ScrollableArea | novo: `osui-scrollable-area-minimal` | novo: `osui-scrollable-area-typical` | - | nao |
| osui.Search | novo: `osui-search-minimal` | novo: `osui-search-typical` | - | nao |
| osui.Section | novo: `osui-section-minimal` | novo: `osui-section-typical` | - | nao |
| osui.SectionGroup | novo: `osui-section-group-minimal` | novo: `osui-section-group-typical` | - | nao |
| osui.SectionIndex | novo: `osui-section-index-minimal` | novo: `osui-section-index-typical` | - | nao |
| osui.SectionIndexItem | novo: `osui-section-index-item-minimal` | novo: `osui-section-index-typical` | - | nao |
| osui.Separator | novo: `osui-separator-minimal` | novo: `osui-separator-typical` | - | nao |
| osui.Sidebar | novo: `osui-sidebar-minimal` | novo: `osui-sidebar-typical` | - | nao |
| osui.StackedCards | novo: `osui-stacked-cards-minimal` | novo: `osui-stacked-cards-typical` | - | nao |
| osui.Submenu | novo: `osui-submenu-minimal` | novo: `osui-submenu-typical` | - | nao |
| osui.Tabs | novo: `osui-tabs-minimal` | novo: `osui-tabs-typical` | - | nao |
| osui.TabsContentItem | novo: `osui-tabs-content-item-minimal` | novo: `osui-tabs-typical` | - | nao |
| osui.TabsHeaderItem | novo: `osui-tabs-header-item-minimal` | novo: `osui-tabs-typical` | - | nao |
| osui.Tag | novo: `osui-tag-minimal` | novo: `osui-tag-typical` | - | nao |
| osui.TimelineItem | novo: `osui-timeline-item-minimal` | novo: `osui-timeline-item-typical` | - | nao |
| osui.TimePicker | novo: `osui-time-picker-minimal` | novo: `osui-time-picker-typical` | - | nao |
| osui.Tooltip | novo: `osui-tooltip-minimal` | novo: `osui-tooltip-typical` | - | nao |
| osui.TouchEvents | novo: `osui-touch-events-minimal` | novo: `osui-touch-events-typical` | - | nao |
| osui.UserAvatar | novo: `osui-user-avatar-minimal` | novo: `osui-user-avatar-typical` | - | nao |
| osui.Video | novo: `osui-video-minimal` | novo: `osui-video-typical` | - | nao |

### OutSystemsCharts e OutSystemsMaps (24)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| charts.AreaChart | novo: `charts-area-chart-minimal` | novo: `charts-area-chart-typical` | - | nao |
| charts.BarChart | novo: `charts-bar-chart-minimal` | novo: `charts-bar-chart-typical` | - | nao |
| charts.ChartExport | novo: `charts-chart-export-minimal` | novo: `charts-chart-addons-typical` | - | nao |
| charts.ChartLegend | novo: `charts-chart-legend-minimal` | novo: `charts-chart-addons-typical` | - | nao |
| charts.ChartSeriesStyling | novo: `charts-chart-series-styling-minimal` | novo: `charts-chart-addons-typical` | - | nao |
| charts.ChartXAxis | novo: `charts-chart-x-axis-minimal` | novo: `charts-chart-addons-typical` | - | nao |
| charts.ChartYAxis | novo: `charts-chart-y-axis-minimal` | novo: `charts-chart-addons-typical` | - | nao |
| charts.ColumnChart | novo: `charts-column-chart-minimal` | novo: `charts-column-chart-typical` | - | nao |
| charts.DonutChart | novo: `charts-donut-chart-minimal` | novo: `charts-donut-chart-typical` | - | nao |
| charts.LineChart | novo: `charts-line-chart-minimal` | novo: `charts-line-chart-typical` | - | nao |
| charts.PieChart | novo: `charts-pie-chart-minimal` | novo: `charts-pie-chart-typical` | - | nao |
| charts.RadarChart | novo: `charts-radar-chart-minimal` | novo: `charts-radar-chart-typical` | - | nao |
| maps.Circle | novo: `maps-circle-minimal` | novo: `maps-shapes-typical` | - | nao |
| maps.DrawMarker | pendente | pendente | - | nao |
| maps.FileLayer | novo: `maps-file-layer-minimal` | pendente | - | nao |
| maps.LeafletMap | novo: `maps-leaflet-map-minimal` | novo: `maps-leaflet-map-typical` | - | nao |
| maps.Map | novo: `maps-map-minimal` | novo: `maps-map-typical` | - | nao |
| maps.Marker | novo: `maps-marker-minimal` | novo: `maps-leaflet-map-typical` | - | nao |
| maps.MarkerPopup | novo: `maps-marker-popup-minimal` | novo: `maps-map-typical` | - | nao |
| maps.Polygon | novo: `maps-polygon-minimal` | novo: `maps-shapes-typical` | - | nao |
| maps.Polyline | novo: `maps-polyline-minimal` | pendente | - | nao |
| maps.Rectangle | novo: `maps-rectangle-minimal` | novo: `maps-shapes-typical` | - | nao |
| maps.SearchPlaces | novo: `maps-search-places-minimal` | pendente | - | nao |
| maps.StaticMap | novo: `maps-static-map-minimal` | pendente | - | nao |

### Padroes de uso (loja) (8)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| usage.cart-line-quantity | novo: `usage-cart-line-quantity-typical` | novo: `usage-cart-line-quantity-typical` | - | nao |
| usage.category-filter | novo: `usage-category-filter-typical` | novo: `usage-category-filter-typical` | - | nao |
| usage.clickable-card | novo: `usage-clickable-card-minimal` | novo: `usage-clickable-card-typical` | - | nao |
| usage.ecommerce-flow | - | - | novo: `ecommerce-*` | nao |
| usage.external-image | novo: `usage-external-image-minimal` | novo: `usage-external-image-typical` | - | nao |
| usage.gallery-data-action | novo: `usage-gallery-data-action-typical` | novo: `usage-gallery-data-action-typical` | - | nao |
| usage.link-icon-text | novo: `usage-link-icon-text-minimal` | novo: `usage-link-icon-text-typical` | - | nao |
| usage.navigation-input | novo: `usage-navigation-input-minimal` | novo: `usage-navigation-input-typical` | - | nao |

### Capacidades do discover (faixa odc) (60)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| data.client-entity | suite: `client-storage` | suite: `client-storage` | - | sim |
| data.client-variable | suite: `security-settings` | suite: `platform-events-lifecycle` | - | sim |
| data.entity | suite: `data-entity` | suite: `data-full-model` | novo: `ecommerce-01-data` | sim |
| data.records | bloqueado | bloqueado | - | nao |
| data.static | suite: `data-entity` | suite: `data-full-model` | novo: `ecommerce-01-data` | sim |
| data.structure | suite: `data-full-model` | suite: `structure-refactor` | novo: `ecommerce-01-data` | sim |
| deliver.feature | bloqueado | bloqueado | - | nao |
| deliver.job | bloqueado | bloqueado | - | nao |
| deliver.publish | bloqueado | bloqueado | - | nao |
| diagnostic.troubleshoot | bloqueado | bloqueado | - | nao |
| integration.external-library-odc | bloqueado | bloqueado | - | nao |
| integration.rest-consume | suite: `rest-consume` | suite: `rest-consume-call` | - | sim |
| integration.rest-expose | suite: `rest-expose` | suite: `rest-expose-lifecycle` | - | sim |
| integration.rest-import | suite: `rest-openapi-import` | suite: `rest-openapi-import` | - | sim |
| logic.aggregate | suite: `logic-aggregate-columns` | suite: `logic-steps` | novo: `ecommerce-*` | sim |
| logic.app-event | suite: `platform-events-lifecycle` | suite: `external-site-and-events` | - | sim |
| logic.client-action | suite: `client-storage` | suite: `action-edit-lifecycle` | - | sim |
| logic.data-action | suite: `data-action` | suite: `data-action` | novo: `ecommerce-*` | sim |
| logic.exception | suite: `logic-steps` | suite: `security-settings` | - | sim |
| logic.expression | suite: `expression-literals` | suite: `client-storage` | - | sim |
| logic.flow | suite: `logic-action` | suite: `cat-a-list-clear` | - | sim |
| logic.native-nodes | suite: `logic-native-nodes` | suite: `exception-lifecycle` | novo: `ecommerce-03-detail` | sim |
| logic.screen-action | suite: `screen-basic` | suite: `logic-native-nodes` | novo: `ecommerce-*` | sim |
| logic.server-action | suite: `logic-action` | suite: `cat-a-list-clear` | novo: `ecommerce-01-data` | sim |
| logic.service-action | suite: `service-action` | suite: `service-action` | - | sim |
| logic.sql | suite: `logic-sql` | suite: `rename-data-propagation` | - | sim |
| logic.variable | suite: `logic-action` | suite: `logic-steps` | - | sim |
| ops.debugger | bloqueado | bloqueado | - | nao |
| ops.environment | bloqueado | bloqueado | - | nao |
| ops.portal | bloqueado | bloqueado | - | nao |
| ops.references-refresh | bloqueado | bloqueado | - | nao |
| ops.studio-session | bloqueado | bloqueado | - | nao |
| read.discover | bloqueado | bloqueado | - | nao |
| read.inspect | novo: `cap-read-inspect-minimal` | novo: `cap-read-inspect-typical` | - | nao |
| refactor.delete | suite: `delete-attribute-no-consumers` | suite: `delete-entity-whole` | - | sim |
| refactor.duplicate | suite: `refactor-inherited` | suite: `refactor-duplicate` | - | sim |
| refactor.move | suite: `structure-refactor` | suite: `screen-block-edit` | - | sim |
| refactor.rename | suite: `setting-lifecycle` | suite: `refactor-inherited` | - | sim |
| refactor.replace | suite: `refactor-inherited` | suite: `refactor-replace-action` | - | sim |
| reference.external-library-odc | bloqueado | bloqueado | - | nao |
| security.settings-roles | suite: `setting-lifecycle` | suite: `security-settings` | - | sim |
| timer.schedule | suite: `timer-action` | suite: `timer-lifecycle` | - | sim |
| ui.block | suite: `cat-b-block-event-delete` | suite: `delete-block` | - | sim |
| ui.block-instance | suite: `cat-b-block-event-delete` | suite: `html-visual-block` | novo: `ecommerce-04-catalog` | sim |
| ui.dropdown | suite: `cat-b-widget-gallery` | suite: `cat-b-widget-gallery` | novo: `ecommerce-04-catalog` | sim |
| ui.dropdown-search | novo: `cap-dropdown-search-minimal` | novo: `cap-dropdown-search-typical` | - | nao |
| ui.email-popover | suite: `email-popover-metadata` | suite: `cat-b-widget-gallery` | - | sim |
| ui.event | suite: `screen-list` | suite: `screen-basic` | novo: `ecommerce-04-catalog` | sim |
| ui.flow-comment | suite: `ui-flow-comment` | suite: `ui-flow-comment` | - | sim |
| ui.form | suite: `delete-screen` | suite: `screen-form` | - | sim |
| ui.html-page | novo: `cap-html-page-minimal` | novo: `cap-html-page-typical` | - | sim |
| ui.html-visual | suite: `html-visual-list` | suite: `html-visual-alert` | - | sim |
| ui.input | suite: `html-visual-alert` | suite: `screen-basic` | novo: `ecommerce-03-detail` | sim |
| ui.list | suite: `html-visual-list` | suite: `screen-list` | novo: `ecommerce-04-catalog` | sim |
| ui.screen | suite: `ui-flow-comment` | suite: `screen-list` | novo: `ecommerce-*` | sim |
| ui.screen-spec | novo: `cap-screen-spec-minimal` | novo: `cap-screen-spec-typical` | - | nao |
| ui.screen-spec.cards | - | bloqueado | - | nao |
| ui.script-resource | suite: `theme-script-resource` | suite: `resource-script-lifecycle` | - | sim |
| ui.theme-css | suite: `theme-css-reload` | suite: `theme-css-halves` | - | sim |
| ui.widget | suite: `html-visual-list` | suite: `cat-b-link-style` | novo: `ecommerce-*` | sim |

### Ausencias declaradas no catalogo (14)

| id | minimal | typical | rich | havia antes |
|---|---|---|---|---|
| absent.ai.agents | suite: `agent-calls +1` | - | - | sim |
| absent.ai.semantic-search | suite: `logic-semantic-search +1` | - | - | sim |
| absent.ajax-refresh-node | bloqueado | - | - | nao |
| absent.button-group-native | novo: `widget-button-group-minimal +1` | - | - | nao |
| absent.data-action-inputs | bloqueado | - | - | nao |
| absent.event.global-events | suite: `global-event-unused` | - | - | sim |
| absent.integration.rest-callbacks | bloqueado | - | - | nao |
| absent.integration.rest-credentials-in-model | bloqueado | - | - | nao |
| absent.integration.soap-odc | bloqueado | - | - | nao |
| absent.module-image | suite: `image-create` | - | - | sim |
| absent.process.odc-workflow | suite: `workflow-nodes` | - | - | sim |
| absent.reference.import-headless-odc | bloqueado | - | - | nao |
| absent.session-variable | bloqueado | - | - | nao |
| absent.web-preparation | bloqueado | - | - | nao |

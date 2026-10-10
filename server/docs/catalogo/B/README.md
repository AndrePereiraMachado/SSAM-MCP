# Frente B — interface e composição (catálogo abrangente)

Data: 23/09/2026. Contrato: `ssam-catalog-contribution/1` (`platforms/odc/facade/catalog/README.md`). Base: M0 `64c3b0d`
(Fase 3 final `7a10686`); segunda entrega sobre a integração `f0a1e3d` (CLIs e resultados carimbados de INT-T2-002).
Este documento descreve o que a Frente B contribui ao catálogo único e como reproduzir; não é outro catálogo nem uma
receita por tela ou componente.

## 1. O que a entrada pública passa a responder

`.\ssam discover "<intenção>" --lane odc|o11` (e `--expand <id>:operations+native+contract+example+evidence`) responde às
intenções de interface com capacidades `shared/2`, uma definição comum e o estado **por papel, operação e faixa**:

| Capacidade | Papéis (tipo nativo qualificado) | Faixas |
|---|---|---|
| `ui.screen` (substitui `ui.screen` e `ui.edit`) | tela `UI.Mobile.IMobileScreen`, fluxo de UI `UI.Mobile.IMobileFlow` | ODC, O11 |
| `ui.flow-comment` | comentário `UI.Mobile.IComment` | ODC, O11 |
| `ui.event` (novo) | evento de widget (ODC `UI.Mobile.Events.IBuiltinEvent`; O11 `UI.Mobile.Events.IUILifeCycleEvent`, a interface que o ledger O11 regista para o OnClick), evento de ciclo de vida `IUILifeCycleEvent` | ODC, O11 |
| `logic.app-event` (legado da B, substituído) | evento de sistema `Logic.ISystemEvent`, site externo `UI.Mobile.IExternalSite`, evento estendido `UI.Mobile.Events.IEvent` | ODC, O11 |
| `ui.block` | bloco `IMobileBlock`, evento de bloco `UI.IBlockEvent`, trigger `ITriggerNode`, placeholder `IPlaceholderWidget` | ODC, O11 |
| `ui.block-instance` | instância `IMobileBlockInstanceWidget`, handler de evento da instância `UI.IEventHandler`, conteúdo de placeholder `IPlaceholderContentWidget`, bloco referenciado `IMobileBlockSignature` (só leitura) | ODC, O11 |
| `ui.widget` (novo) | container, texto, expressão, elemento HTML, ícone, If, botão, link, imagem (NRWidgets / UI.Mobile.Widgets) | ODC, O11 |
| `ui.input` (novo) | form, input, checkbox, switch, text area, radio group/button, upload, button group/item, label | ODC, O11 |
| `ui.list` | lista, item, ação do item, TableRecords, header/row cell | ODC, O11 |
| `ui.dropdown` | dropdown nativo `NRWidgets.IDropdown` | ODC, O11 |
| `ui.html-visual`, `ui.screen-spec`, `ui.html-page` | rotas compactas (sem papéis: os widgets que criam são os papéis acima) | ODC, O11 |
| `ui.theme-css` | tema `UI.Mobile.IMobileTheme` | ODC, O11 |
| `ui.script-resource` | script `UI.IScript`, recurso `Data.IResource`, imagem do módulo `UI.IImage` | ODC, O11 |
| `ui.email-popover` | e-mail `IMobileEmail` (só ODC: o runtime O11 11.55.87 não carrega o tipo), popover, popup, `ITextMetadata` | ODC, O11 |
| `ui.traditional-screen`, `ui.traditional-widget` (novos) | tela/fluxo/bloco/instância/e-mail/tema web, eventos OnClick web, widgets web | **só O11** |
| `ui.form`, `ui.dropdown-search` (padrões, substituem os legados) | sem papéis: compõem `ui.screen`, `ui.input`, `ui.block-instance` e a lógica da Frente A | ODC, O11 |

`ui.form` e `ui.dropdown-search` são `shared/2` nas duas faixas. Com a lógica da Frente A publicada nas duas faixas
(integração `0e9db9d`, D-M2-6) as referências a ela deixaram de ter restrição de faixa e de ficar em `requires`:
`ui.form` → `depends` `logic.server-action`; `ui.dropdown-search` → `depends` `logic.screen-action`; `ui.event`,
`ui.block`, `ui.block-instance`, `ui.input` → `recommends` `logic.screen-action` (e `logic.data-action` em `ui.event`);
`ui.traditional-screen` (só O11) → `recommends` `logic.screen-action` e `logic.preparation`. A B não tem `requires`
pendentes. Ausências: `module-image` (as duas faixas, limite do kernel) e `button-group-native` (só ODC; no O11 há prova
de job).

O vocabulário de UI (`fragments/B/ui-vocabulary.json`) acompanha o descritor ODC depois da poda do A-004: "input" não é
variante de "form" (senão "input" selecionava `ui.form` e não `ui.input`, e a união por chave de `f0a1e3d` o recolocava
nas duas faixas); `ui.input` responde por "input de texto"/"campo de texto"/"caixa de texto", nunca por "input" solto,
que pertence também a "input parameter" da lógica. Um grupo `save` estreito ("salvar", "gravar", "guardar", subconjunto
do grupo do descritor ODC) faz o O11 ler "salvar" como o ODC; o título de `ui.form` não cita "id" nem "load" e o resumo
não cita "server" (senão "consultar registros" e "salvar … numa server action" punham `ui.form` à frente dos dados e da
lógica); `ui.traditional-screen` responde por "tela web tradicional"/"tela tradicional" e deixou "preparation" para
`logic.preparation` (A), que recomenda.

## 2. As quatro camadas, separadas

1. **Widget nativo** — papéis das capacidades de widget, com o tipo qualificado e o contrato nativo lido do runtime
   (`--expand <id>:native`).
2. **Assinatura referenciada** — o bloco/tela/tema de outro módulo é lido pela captura (`discover --app <captura.oml>`,
   `element:MobileBlockSignature:<Nome>`); no consumidor é `not-applicable` para create/set (com a alternativa: editar no
   produtor e atualizar a referência, Frente C). A contabilidade das 179 assinaturas (ODC 97, O11 82) diz o mesmo por
   tipo; `discover --app` devolve tipo, nome e referência de job de cada uma, mais os inputs, eventos e placeholders que
   ela declarar.
3. **Instância configurada** — `ui.block-instance`: argumentos (`set $inst/<Input> Value`), handlers
   (`set $inst/<Evento> Handler`), conteúdo de placeholder.
4. **Regra de ligação/composição** — `ui.event` (OnClick/OnReady/OnAfterFetch → Destination) e as `bindings` extraídas dos
   jobs de prova (`set <IButton>/OnClick Destination = <IScreenAction>`, `set <IList> Source = <Aggregate>.List`).
   O corpo da action é da Frente A e é referenciado (`requires` enquanto a versão das duas faixas não existe), nunca
   copiado.

## 3. Contextos: sem equivalência inferida

- Contexto = tipo do módulo (`AppFactory.cs:46-54`), não a raia `ss4/ss5`. Reactive e Mobile partilham `IMobileScreen`
  (o placeholder principal do layout é `MainContent` no Reactive e `Content` no Mobile); Traditional Web usa `IWebScreen`
  e widgets web, com a Preparation (lógica, Frente A) em vez de eventos de ciclo de vida.
- ODC: apps Reactive e Mobile (`HANDOFF.md:490`); o kernel recusa o contexto web num módulo CrossDevice
  (`ScreenModel.cs:300-305`, código, sem job negativo). Os tipos web do inventário ODC ficam **excluídos** com o motivo;
  quando o censo da fixture mostra que objetos CrossDevice implementam a interface web (WebScreen 11, WebFlow 5,
  WebBlockInstanceWidget 271…), a classificação é `base` desses objetos; quando o nome curto colide com o tipo Mobile, o
  censo não decide e isso é dito.
- Diferenças medidas entre faixas: legenda de botão dentro de `IContent` no ODC e ao lado no O11; filhos de lista sob
  `IContent` no ODC; o OnClick O11 é registado como `IUILifeCycleEvent`; `IIcon` com Weight no ODC; nenhum e-mail Reactive
  no O11.

## 4. Evidência (o que é prova e o que não é)

- Estado declarado ≠ prova: o motor calcula `proven-current`/`proven-historical`/`declared-not-proven` pelo carimbo e pelo
  ledger qualificado do papel. Resultados usados: só os de distribuições anunciadas (INT-T2-002, INT-T2-003 e INT-T2-004;
  CLIs com o hash do host de testes, hoje O11 `e8cac2f7d6786b1f`, ODC `780bb1b0ffe67775`), nunca resultados parciais nem
  saídas de sonda. ODC: 79/80 resultados atuais. O11: 92 carimbados (`tests/provenance-o11.json`).
- **B-006** (jobs `cat-b-*` novos, sonda a frio e depois carimbo em INT-T2-004): ODC `cat-b-block-event-delete`,
  `cat-b-widget-gallery`, `cat-b-choice-table`; O11 `cat-b-app-events`, `cat-b-flow-comment-popover`,
  `cat-b-theme-resource`, `cat-b-block-placeholder`, `cat-b-traditional-gallery` (e o carimbo de `process-expense-
  traditional` e `consume-reference-screens`). Cada declaração que eles provam foi escrita a partir do próprio resultado
  (número dos ops como gravado, base 0; propriedades; contagens de consumidores; `force`/`brokenConsumers`), pelo par
  (tipo nativo do papel, operação) que o ledger registra. Medidos pela sonda e incorporados: o RadioGroup do ODC nasce com
  `RadioButton1..3` de exemplo sem `Value` (o job apaga-os); no O11 a fábrica de `ISystemEvent` escolhida é
  `CreateOnApplicationReady`; no O11 um comentário criado num UI flow responde como `Logic.Nodes.ICommentNode` (tipo de
  A) e o papel `comment` do O11 é declarado sobre ele, com coordenação (a contabilidade de `UI.Mobile.IComment` no O11
  fica `undetermined`, regra `o11-flow-comment-node`); o `Reminder` desse comentário sai em `MainFlow / CommentNode`.
- Os 147 testes de contrato `kernel/tests/contracts/screen-coverage` (Reactive 51, Mobile 52, Traditional 44: Verify
  nativo, recarga, merge de 3 vias, mutação recusada) correm fora das suítes de jobs e não têm carimbo de identidade:
  são citados como evidência **histórica** nas notas, nunca como `proofs`.
- Ciclo de vida de tela/bloco: `cat-b-screen-lifecycle` (o mesmo cenário nas duas faixas: OnInitialize/OnReady/OnDestroy
  de tela e OnParametersChanged de bloco ligados a screen actions, 73 ops) passou nas duas suítes completas de INT-T2-002
  e prova set (ligar Destination) e read do papel "evento de ciclo de vida" (`IUILifeCycleEvent`) nas duas faixas; create
  é `not-applicable` (o evento nasce com a tela, o bloco ou a data action). OnRender não é exercido. No O11 o OnClick de botão também é registado como `IUILifeCycleEvent`; por isso a prova do papel de ciclo de
  vida é só o job que liga os eventos de ciclo de vida, nunca um job de clique.
- Negativos: só contam jobs com `expectError` (D-M2-3, resolução de B-003). `dropdown-prompt`, `dataaction-list-scope` e
  `structure-list-scope` (sem `expectError`) continuam como nota/limite.
- Auditoria de evidência (`gerador/audit-evidence.mjs`, depois de cada distribuição): nenhuma declaração
  `applicable`/`conditional` sem prova atual e nenhum par (tipo da B, operação) executado por um resultado atual sem
  declaração, nas duas faixas (a remoção limpa de evento de bloco no ODC passou a ter prova: `cat-b-block-event-delete`).
  Declarações: ODC 159 `proven-current`, 3 `undetermined` (leitura de bloco referenciado pela assinatura e 2
  derivadas); O11 207 `proven-current`, 1 recusa provada (rename de system event, negativo
  `jobs-negative/cat-b-system-event-rename`: "Cannot find handler for object OnApplicationReady…"), 17 `undetermined`
  (16 do papel `email`, que o runtime O11 não carrega, e a leitura de um link, que nenhum job O11 faz).
- **B-009:** ODC `cat-b-link-style` prova `set` (Style, Enabled) e `read` do próprio `ILink`; o O11 recusa renomear um
  system event, como o ODC.
- **B-008** (`cat-b-block-rename`, O11): renomear o evento de bloco segue os 2 consumidores pela chave (o trigger e o
  handler da instância) e o trigger segue o seu consumidor — diferente do ODC, onde esse rename devolve sucesso e não
  grava nada. O rename de extended event no O11 é `not-applicable` pela Model API (`IEvent` sem `Name`).
- **B-007** (`cat-b-screen-replace-delete`, sonda e carimbo): o verbo `replace` repontou os dois consumidores de uma tela
  sem input para outra tela (2 religados, 0 restantes) e a antiga saiu sem `force`, nas duas faixas; mover tela no
  canvas nas duas; no O11 também delete de tela e de botão, reordenar expressão e rename de UI flow.

## 5. Limites representados (sem conversão universal)

`html-visual` é uma tabela fechada de tags → widgets (rejeita `script`, `#id`, `@import`, tags fora da tabela; não cria
lógica, dados nem variáveis); `html` página recusa `form/img/script/...`; o compilador JS (`HtmlComponents`) é legado; o
catálogo offline OutSystemsUI (`kernel/catalog/ui`) não é usado pelos jobs nem pela resposta: o contrato de um bloco de
biblioteca é a assinatura no módulo. Componentes de terceiros só são conhecidos pela assinatura da revisão referenciada.
Recomendações (preferir classes e padrões existentes a CSS/JS próprio) estão em `guidance` e ditas como recomendação.

## 6. Reprodução

```powershell
node platforms/odc/facade/catalog-check.mjs --front B                      # T0 puro: 0 erros, 0 não contabilizados
node docs/catalogo/B/gerador/normalize-fragments.mjs --check               # ordem das operações e provas por papel
node docs/catalogo/B/gerador/gen-accounting.mjs --check                    # contabilidade gerada (regras com origem)
node docs/catalogo/B/gerador/metrics.mjs                                   # denominadores separados, evidência calculada
node docs/catalogo/B/gerador/audit-evidence.mjs                            # sobre/subdeclaração contra os carimbos atuais
.\ssam discover "botao que navega para a tela de detalhe" --lane odc --rebuild   # T0 real (ODC ~55 s)
.\ssam discover "botao que navega para a tela de detalhe" --lane o11 --rebuild   # T0 real (O11 ~65 s)
node --test --test-reporter=tap "platforms/odc/facade/tests/catalog-b-*.test.mjs" # T1 da frente
```

`gen-accounting.mjs` escreve `fragments/B/accounting.json` (uma entrada por tipo da B que nenhuma capacidade representa,
regra e origem por entrada; não editar à mão). Lê os tipos da raiz de objetos e os `typesOutsideRoot` do inventário
reconciliado (ODC 1.7.25): hoje ODC 227 tipos + 1 fora da raiz (`UI.IGridLayout`, regra `outside-root-ui-helper`,
contado no bloco `outsideRoot`) e O11 197, 0 não contabilizados. Os 7 tipos ODC acrescentados pela reconciliação são
Traditional Web (`ICommentWidget`, `IImageWidget`, `IListBoxWidget` e as assinaturas destes dois) ou a entrada da lista
especial do combo web (`ISpecialListEntry`, fábrica única `IComboBoxWidget.CreateSpecialList`, e a sua assinatura):
excluídos com o motivo; quando o censo da fixture não tem o tipo, o motivo diz isso em vez de inferir. `normalize-fragments.mjs` põe as operações em ordem de autoria
(`create`, `set` primeiro: são as que uma resposta mantém inteiras quando a intenção não nomeia operação) e limita as
provas por papel a 2, na ordem escrita, com uma vaga para um resultado carimbado quando nenhuma das mantidas o tem; a
lista completa fica em `platforms.<faixa>.proofs`. O `scope` de cada declaração só afirma o que as provas mantidas fazem,
atribuindo o fato ao job (`... (screen-basic); ... (screen-list)`).

## 7. Verificação independente

Um subagente só de leitura (sem autoria destes fragmentos) tentou refutar as 207 declarações `applicable`/`conditional`
contra os jobs e o ledger qualificado. Resultado aplicado antes da entrega: um tipo nativo refutado (evento de clique web:
`Web.Events.IBuiltinEvent`, não `IOnClick`), cerca de 22 `scope` que descreviam jobs cortados, uma declaração subestimada
(leitura do OnClick no O11: agora `applicable` por `screen-form-reactive`), uma origem inexistente corrigida, nomes de
cabeçalho do NAO-DA corrigidos e um negativo que não pertencia a `ui.screen` retirado.

Na segunda entrega, com os resultados carimbados de INT-T2-002, a auditoria de subdeclaração achou 28 pares
(tipo, operação) executados por resultados atuais sem declaração da B: 27 viraram declarações `applicable` com as provas
desses jobs (leituras, usos, criação de texto, estilo de botão e link, remoção de imagem, trigger de bloco, bloco
referenciado lido pela assinatura, o `set` da tela web com o link lista→detalhe), e a leitura de `IContent` (nasce com o
dono) ficou na contabilidade. À parte, o `set` de link no ODC, sem job, passou a `undetermined` declarado. A prova do link criado no O11 passou de um job sem carimbo (`consume-reference-screens`, agora
nota) para `gallery-native-reactive` e `html-dashboard-reactive`.

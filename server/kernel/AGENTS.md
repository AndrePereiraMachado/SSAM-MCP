# SSAM Hybrid: playbook para agentes (LLM) sem contexto

## Official Traditional components from the first delivery

WebResponsive uses OutSystemsUIWeb/RichWidgets; do not offer Reactive/IPopup examples. Keep the official layout/theme
and its placeholders, without building another menu in MainContent. Read the installed contract before using
inputs/events; prefer compatible official components to recreated overlays, paging and feedback.
Popup_Editor when explicitly asked for: a named link with OnClick.Method=Navigate, LinkOrButtonWidgetId=Link.Id, a
separate screen with LayoutPopup, Notify -> Close on success and OnNotify in the parent to query/assign/Ajax Refresh.
The block and its link are updated together. Referenced actions use IReference:Producer/IServerActionSignature:Action.
Check deprecation and devices: Popup_Editor 5404 is legacy without mobile support; for new responsive modals, prefer
the compatible official Modal. When a browser acceptance is asked for, prove the initial load, the served CSS and the
behaviour after Ajax, as well as open/close, cancel and validation.

## Traditional interactions: Ajax Submit, Navigate and Submit

Choose by the effect of the interaction. Navigate goes to a screen/URL with explicit parameters. Ajax Submit runs a
Screen Action and keeps the screen. Submit sends the whole page, which native upload/download needs.
Tabs and opening/closing modals use Ajax, a state assignment and an Ajax Refresh of a persistent container around the
If. Filters/paging first fetch the data and assign the lists/values the interface is bound to.
Ajax does not run the Preparation of the screen again; Ajax Refresh only renders, it does not query the database.
Use validation=None for navigation, tabs and paging. Mutations keep their authorization and validations on the server.

In a new document: `button/a onclick="Action" method="Ajax|Submit|Navigate" validation="None|Server|ClientAndServer"`.
In the installed Model API only `ILinkWidget/OnClick` exposes Method/Validation. A button with an explicit policy becomes
a native link with the Button class; the plain legacy button keeps Submit. Existing screens use edits by @key, keeping
arguments, text, order, styles and visibility conditions. `IAjaxRefreshNode.WidgetOrWebBlock` points to the refreshed
container. Example `traditional-ajax-navigation.json` in `tests/jobs`, proven in `tests/Anvil.Tests/TraditionalAjaxTests.cs`
together with the JSON contract of Ajax Refresh.
A clean publication does not prove the interaction: check in the authenticated browser Ajax without a navigation of the
document, the parameters of Navigate and the file transfer with Submit. Record separately what stayed blocked.

Guia de desenvolvimento do kernel. Sessao de app trabalha so pelo MCP `ssam` (regras no `AGENTS.md` da raiz) e nao le
este arquivo: `ssam_discover` e `ssam_reference` respondem a partir dele.

Este repositorio compila intencao para OutSystems O11 e entrega no Service Studio aberto por merge. Voce nao precisa
saber nada de antemao: cada tarefa abaixo diz quando usar, onde pode, que exemplo copiar e como verificar. Leia so o que
a sua tarefa pede. Se algo aqui nao bater com o que o codigo faz, o codigo manda e este arquivo esta errado: corrija-o.

## Fluxo controlado de app (dados e actions declaradas)

Autoria de componentes por HTML/CSS/JavaScript: consulte `docs/UI-HIGH-CODE.md` e
`tests/html/components/gallery.html`. No perfil controlado, a fonte inteira entra em `propose.uiSource`;
o Hybrid gera o contrato nativo e os bindings. Para manutencao autorizada, `deliver --spec arquivo.html`
usa o mesmo controlador. O recorte provado cobre componentes, composicao, eventos, estado, lifecycle e
controles basicos e imports relativos de arquivos HTML (`uiSource` aceita tambem `{entry, files}`).
Blocks de referencias registradas aceitam `import { Block } from 'outsystems:Modulo/Flow'`;
o compilador usa a assinatura e o nome original do produtor, inclusive com aliases locais no Studio.
Objetos/arrays literais em estado local inferem estruturas/listas nativas: exemplo `tests/html/components/values.html`.
Map/spread e listas vazias depois da inicializacao funcionam; IDs grandes devem permanecer texto. Arrays inicialmente
vazios, datas/null sem tipo declarado e inputs/eventos compostos ainda nao estao implementados.
Aquisicao automatica de dependencias, imports de actions/tipos, repeticao visual e chamadas assincronas ainda
nao estao completos nessa entrada. Nao confundir a cobertura do backend com suporte universal a HTML/CSS/JS.
Para jobs ODC, a aquisicao candidata de assinaturas publicas de bibliotecas (incluindo sistema) esta documentada
em `../platforms/odc/docs/AQUISICAO-DEPENDENCIAS.md`. Ela usa `reference` antes das edicoes e `studio_deliver`;
nao abre o produtor protegido como OML. Verifique o estado de liberacao: prova viva e ativacao ainda pendentes.
O Dashboard legado ainda usa a receita anterior enquanto essas capacidades convergem.

O perfil opcional `ssam-app` usa `context`, `propose`, `continue` e `status` do MCP ssam_hybrid.
O cliente registra o pedido original; o Hybrid fixa o contrato, gera o delta e retoma a mesma tarefa depois de falhas.
A prova le dados e grafo de actions independentemente dos ops emitidos. O esquema de logic inclui switch, handlers,
JSON, JavaScript, Excel e os nos nativos declarados de UI/email. Screen actions e preparacoes usam owners existentes;
o mapa de widgets e gerado por scripts/action_coverage_report.py a partir dos testes de recarga/merge.
Politicas em `docs/CONTRATO-MODULO.md`. Detalhes de ativacao e limites em `docs/APP.md`; estado da
instalacao/prova viva em `docs/tasks/2026-09-05-plano-fluxo-controlado.md`. Perfil configurado nao equivale a prova viva.

Nesta sessao de app, CLI, shell, arquivos de infraestrutura e publicacao nao sao ferramentas de recuperacao.
Falta de capacidade e bloqueio especifico. O certificado cobre o contrato declarado e as politicas de acesso geradas;
nao comprova toda regra de negocio nem substitui testes executando as actions no servidor.
Nao migre automaticamente tarefas legadas em andamento; o perfil de manutencao e as outras sessoes ficam separados.

O CLI abaixo continua disponivel para manutencao, provas e compatibilidade durante a migracao. `deliver --spec`
verifica o contrato do modulo (data/roles/exceptions/logic); `deliver --resume <taskId>` retoma sem substituir job/alvo/checks. `--job` legado
nao se torna uma entrada alternativa dentro da sessao de app controlada.

## Entrega de app: caminho direto

Criar entidades/actions/telas no OutSystems e uma tarefa de APP. Corrigir o compilador, a bridge ou o worker e
MANUTENCAO DO ANVIL. Nao transforme uma entrega de app em manutencao: se uma capacidade faltar, reporte o bloqueio
com o comando e a capacidade ausente; nao abra src/ nem implemente infraestrutura por iniciativa propria.

Para uma spec aprovada: escreva um job compacto com spec/logic/screen, rode `anvil check-job --job <job>.json` e
`anvil deliver --module <Modulo> --job <job>.json --checks <nomes>`. O deliver ja faz snapshot, apply, Verify,
merge unico e delta; nao e necessario aplicar o mesmo job antes, rodar todos os jobs de exemplo, e aplica-lo outra
vez para entregar. Use `run_job.py` separadamente quando a tarefa for uma prova em fixture, sem entrega ao Studio.
Se houve erro, corrija todos os diagnosticos retornados e repita apenas o que falhou. Nao rode duas suites em paralelo
na mesma faixa. Uma falha de job de outra sessao nao autoriza conserta-lo nem bloquear a entrega do seu app.

O worker arranca automaticamente. Nao rode build/restart para criar um app quando o CLI ja esta disponivel;
`build.py` e para mudanca de codigo C# ou instalacao ausente. Para jobs/specs, o Verify do proprio job e o delta
vivo sao os gates de entrega. A suite completa e gate de manutencao do Anvil e CI, nao pre-condicao de cada app.
Mantenha verificacoes de regras de negocio proporcionais ao pedido; Verify nao prova autorizacao nem transacoes.

`check-job` nao carrega o Studio: valida sintaxe de spec/logic, nomes/aliases/ciclos e parametros sem uso antes de
reconstruir bases. Com o Studio instalado, julga as propriedades dos `set` pela Model API (PropertyRules), como o apply. Devolve todas as falhas independentes, contagem de actions publicas/helpers, corpos identicos e
endpoints que terminam sempre em excecao. Nao reporte esses endpoints como integracoes implementadas. Corpos
identicos com nomes diferentes pedem revisao de intencao e consumidores; nao apague APIs diferentes automaticamente.
`timings` em apply mostra load, Verify, apply, diagnosticos, save e release. Compare o mesmo job/base/runtime;
conte separadamente escrita pela LLM, espera, ferramenta e retrabalho. Metas do dono: 2-3 min para modelo aprovado
com ~111 entidades e 5-10 min para ~170 actions; nao reduza escopo, autorizacao ou validacao para caber no prazo.

Recusa unica (decisao do dono, 10/10/2026): job com problema e recusado UMA vez, com todos. `apply --job <j> --base <oml>
--out <o>` (e `--producer Nome=<oml>`) roda as fases em ordem na copia descartavel da base: preflight, checagem da base,
apply (op que falha fica registrada, dependentes pulados; op que o preflight recusou inteira nao roda) e Verify do que aplicou.
O `fix` segue o codigo do problema e a orientacao explicita `Fix:` da origem, nunca a gramatica de logic para uma colisao
ou um tipo ausente. Declaracoes validas de um DDL recusado continuam conhecidas: quem depende delas recebe
`APPLY_SKIPPED`, sem um segundo erro de tipo. Actions novas sao conferidas contra o namespace nativo (modulo, entidades,
referencias) tambem quando o job importa produtores, respeitando os escopos de cliente e servidor; `NAME_COLLISION`
traz `taken` e um patch verificado com nome livre. Em listas de texto, dependentes sao pulados por item e por dono,
sem esconder o Verify de actions independentes. Patches de uma mesma fonte incluem todas as correcoes dessa fonte.
A recusa `PREFLIGHT_REFUSED` traz em `problems[]` a uniao das fases: `phase` (preflight, base, apply, verify), `op`, `pointer`,
`code`, `message`, `fix` e `patch` quando a correcao e unica. Erro do Verify: `code` = id do Verify, `element`, `key`, ponteiro
ate a expressao quando o texto esta no job. O mesmo lugar sai uma vez (fica o que tem patch). Nada e salvo. O envelope traz
`verifyRan`, `verifyReason` e `phases` (as fases executadas, inclusive na rodada que verifica os patches).
`check-job` le so o job: `verifyRan:false` com o motivo; base que nao carrega, idem.
Fase seguinte que para sem a uniao (assinatura congelada de produtor sem o elemento) tambem: recusa do preflight, com o motivo.
Mensagem do Verify sobre o que um op falho deixou pela metade nao entra (aviso `VERIFY_OF_FAILED_OPS_OMITTED`). Problema de
uma fase so mantem o code e o texto de antes (DELETE_HAS_CONSUMERS, upgrade do banco) e o envelope vem completo do mesmo jeito:
`verifyRan`, `phases` e `problems[]` no formato da recusa unica (`Errors.Annotate`). Assinatura congelada de produtor sem o
elemento: `REFERENCE_ELEMENT_MISSING` em `/ops/<i>/elements/<k>`, `verifyRan:false`. Candidato que so o Verify recusa (nenhum
op falhou, `accepted:false`): os erros vem tambem em `data.problems` (op, ponteiro, element, key, fix), com `verifyRan`.
Op logic com varias actions (sem `replace`): a action que falha no apply sai da op, e sai tambem a action da op que a chama
(aviso `APPLY_SKIPPED` com o ponteiro dela); o resto da op aplica de novo e chega ao Verify. Cada problema aponta para
`/ops/<i>/data/actions/<j>/...` do job escrito (`ModelSession.IsolateActions`). Spec e html ainda falham a op inteira.
Regras com patch exato: site property sem `Site.` (ODC: setting sem `Settings.`), funcao desconhecida com uma unica builtin
certa (`FunctionCatalog.Certain`: NullDateTime -> NullDate, Len -> Length, um erro de letra), output ou argumento de action do
proprio job escrito errado (patch quando so um casa) e `EXPRESSION_SYNTAX` em toda expressao de logic e de `set` na base
(`Preflight/ExpressionSyntax.cs`: aspas, `#data#`, parenteses, `==`, `&&`, `||`, `!=`, aspas simples, operando sem operador).
Entrega O11 (`Delivery.cs`): o preflight puro nao recusa mais antes do Studio; a captura e o apply recusam com tudo. Sem
captura (modulo nao abre, bridge falha) a recusa e a do preflight, com `verifyRan:false` e o motivo.
Provas: `pa4-pc-four-phases.json` e `pa4-pc-isolated-action.json` (`tests/jobs-negative` e `tests/jobs-odc-negative`),
`tests/Anvil.Tests/PrimeiraCertaTests.cs` e `tests/Anvil.Tests/PrimeiraCertaCompleteTests.cs`.
Parser tolerante de `ssam-flow/1` (R5, 24/10/2026, `FlowParse.cs` `FlowTolerance`): antes da passada estrutural, linhas inteiras
com uma unica leitura sao reescritas e listadas em `normalizations`: `FLOW_INDENT_UNIT`, `FLOW_LINE_CONTINUATION`,
`FLOW_SWITCH_INDENT`, `FLOW_ELSE`, `FLOW_DECLARATION_ORDER`, `FLOW_LABEL_SPACING`, `FLOW_ASSIGN_SPACING`, `FLOW_RESULT_SPACING`,
`FLOW_ARGUMENT_SPACING`, `FLOW_NAVIGATE_ARGUMENTS`, `FLOW_JUMP_BY_NAME`, `FLOW_UNREACHED_END`, `FLOW_MAPPING_SPACING` (tabela com
o antes e o depois em `docs/TEXTO-LOGICA.md`, "Parser tolerante"). Uma chamada nomeada e sempre um no, nunca atribuicao do bloco
`assign` acima; o que nao normaliza continua `FLOW_SYNTAX` com a forma aceita ao lado e, quando certa, o `patch` da linha.
Normalizacoes (lentidao 12/10/2026, `Preflight/JobNormalizer.cs`): erro de forma com uma unica leitura e reescrito no job em
memoria antes das checagens (o arquivo nunca muda) e listado em `normalizations` ([{rule, path, from, to, message}], no
resultado aceito, no `check-job`, no envelope da recusa e no resultado da entrega recusada), nunca recusado:
`FLOW_KIND_PREFIX_DROPPED` tira `I<Kind>:` de uma linha de chamada recusada somente quando ela passa a ser lida;
literais e rotulos nao mudam. `DDL_TYPE_BRACE_ADDED` fecha um bloco de tipo antes da proxima declaracao ou do fim do texto
somente quando todos os campos formam uma declaracao valida. Statements DDL de index/event/sample resolvem seu dono
em qualquer ordem no texto ou pelo nome na base; dono inexistente e `DDL_OWNER_UNKNOWN`.
`SORT_KEYS_SPLIT` (sort `"A, B DESC"` vira `["A", "B DESC"]`, desempates mantidos), `LIST_ENTITY_SEGMENT_DROPPED`
(`V.Current.T.X` e `V[i].T.X` numa `T List` de input/output/variavel ou output de call viram `V.Current.X`/`V[i].X`, so com os
atributos de T conhecidos; `Agg.List` nunca), `NULL_FUNCTION_REWRITTEN` (com a base: `NullDateTime()`/`NullTime()` que nao sao
funcao do modulo viram o nulo do tipo alvo de assign, argumento, campo de record ou comparacao: Date `NullDate()`, Date Time
`DateToDateTime(NullDate())`, Time `NewTime(0, 0, 0)`; `NullTime()` sem tipo conhecido vira `NewTime(0, 0, 0)`) e
`PROPERTY_SET_DROPPED` (set de propriedade de documentacao, hoje so `Description`, que o tipo nao escreve: aviso, a op vira
nada; qualquer outra propriedade segue `PROPERTY_NOT_WRITABLE`). Ambiguo continua recusa: chave de sort vazia, segmento que
pode ser atributo, `NullDateTime()` sem tipo alvo (dentro de If, argumento de builtin) ou com tipo que nao e data/hora. Job com
`expectValid:false` nao e normalizado. Provas: `tests/Anvil.Tests/JobNormalizerTests.cs`.
Motor 2 (12/10/2026, classes que so o apply ou o Verify achavam, uma por rodada; FolhaPonto_UI: 6 entregas): normalizacoes
listadas, no mesmo passe: `PROPERTY_ALIASED` (`Preflight/PropertyAliases.cs`: `Handler` num evento de ciclo de vida e
`Destination`, `Destination` num evento de widget e `Handler`, `Name` numa extended property e `Property`; so quando o Model API
diz que o elemento nao tem o nome escrito e escreve o outro; no preflight com o tipo do alvo, no apply com o elemento),
`ICON_NAME_NORMALIZED` (catalogo do proprio Studio: no O11 o recurso de icones do plugin NRWidgets, lido sem carregar; caixa, prefixo
`fa-` e palavras de classe (`fa fa-home`, `fa-solid fa-home`, `fas fa-home fa-fw`), `_` por `-`, forma `-o` quando so ela existe),
`ICON_WEIGHT_DROPPED` (documento `<screen>`/`<block>` no O11: o Icon do O11 nao tem Weight), `LIST_ALIAS_REWRITTEN`
(`<x list="S" as="a">`: `a` vira a linha da List como a correcao do HTML_FOREACH le (`ScreenDocument.AliasRow`: `S.Current`;
agregado do documento: `Ag.List.Current.Entidade.X`) nas expressoes de dentro, nunca o nome do parametro de um evento
`Acao(P = a)`; `as` sai; alias interno de mesmo nome fica com o seu; agregado sem fontes escritas e recusa `LIST_ALIAS_AMBIGUOUS`),
`SCREEN_TITLE_QUOTED` (titulo que nao e expressao, ou uma palavra solta sem nome declarado parecido, vira texto; caminho com ponto
ou nome a uma ou duas letras de um declarado e recusa `SCREEN_TITLE_UNRESOLVED`, com os mais proximos),
`DEFAULT_MOVED_TO_INITIALIZE` (`<var default>` que nao e literal vai para o inicio do OnInitialize da tela: o que o root nomeia e
o job declara, ou um `OnInitialize` novo ao lado das acoes da tela; nao o default que le agregado ou data action da tela, que
buscam depois do OnInitialize: esse e recusa `DEFAULT_NOT_LITERAL` pedindo o On After Fetch da fonte), `DEFAULT_MOVED_TO_ASSIGN`
(o mesmo para local e output de acao logic: primeiro assign), `PARAMETER_RENAMED` (`Preflight/ScopeRenames.cs`: output/local de
data action e input/local de screen action com nome de variavel, input, agregado ou data action da tela viram `Nome2`, como o
Studio faria, com todas as referencias do job reescritas: corpo, `DataAction.Saida` nas acoes, em cada expressao do documento
elemento por elemento (valor de atributo, `{{ }}` de atributo de texto e de texto, expressoes dos argumentos de evento) e nos
sets de elemento daquela tela; args de call e o nome do argumento de nivel de cima de `Acao(Param = ...)` do documento, nunca uma
comparacao dentro dele; input nunca e atribuido, entao a chave de assign continua sendo a variavel da tela) e
`ARGUMENT_RENAMED` (`Preflight/SystemCalls.cs`, O11: `List`/`SourceList` das acoes de lista do System pelo nome que cada uma tem)
e `TEXT_LITERAL_QUOTED` (`Preflight/SpecTexts.cs`: valor de registro estatico ou default de atributo de texto do spec, sem aspas
e que nao e expressao, como `Limpeza pos-obra`, vira o literal de texto; palavra solta segue com o LiteralFix; expressao fica).
Recusas no mesmo passe, com patch quando certo: `ICON_UNKNOWN` (patch so quando o sentido e certo: tabela de nomes Material Icons
e Font Awesome 5/6 para o FA 4.7 (`schedule` e `clock-o`, `fa-solid fa-house` e `home`), ou palavra de busca exata de um id ou
das variantes de um id (`logout` e `sign-out`, `add` e `plus`); o patch e o html como foi mandado com so o atributo icon trocado;
por grafia so lista opcoes, sem patch), `DEFAULT_NOT_LITERAL` (input, OnInitialize que o job nao declara, default que le dado
buscado), `NAME_COLLISION` (duas declaracoes de um nome no documento; data action que tambem le o nome da tela, ou saida lida
por set de elemento cuja tela o job nao diz: sem patch; parametro O11 chamado `Roles`), `NODE_NOT_ALLOWED`
(`Preflight/NodeRules.cs`, com o tipo do modulo, mesmo em job com reference: Download em modulo Mobile, com patch que cria a client
action `DownloadFile` com o JavaScript que decodifica o Base64 e chama ela no lugar; a rodada recusada aplica o op ja com o patch
no apply e no Verify, nunca salvo, e diz `patchProven`; Ajax Refresh fora de Traditional). O Verify das acoes que uma op falhada
declara (o `InvalidFlow_NoStart` da acao nascida vazia pelo documento) e cascata: sai dos problemas, com uma linha que diz quantos
e quais. Respostas no job como foi mandado (`Preflight/SentJob.cs`): as normalizacoes marcam o que inserem (passo, acao), o que
escrevem no lugar (sort em lista, patch do diagnostico) e as chaves que renomeiam; todo pointer e patch (preflight, base, apply,
Verify) e o path das normalizations sao traduzidos de volta; patch com lugar dentro do que o kernel inseriu sai sem patch; patch
que escreve inteiro um html normalizado com default movido leva junto o passo ou a acao do OnInitialize. O preflight do runner
normaliza uma copia do job; o job do apply e lido de novo e normalizado com as marcas. Provas: `tests/Anvil.Tests/Motor2PreflightTests.cs`.
Familias (12/10/2026, VisitaCerta_UI escrito a mao: 22 escritas, 13 recusadas; cada falha virou a regra da sua familia, em toda
forma que escreve o mesmo lugar). Normalizacoes listadas, antes das de motor2: `DDL_DECLARATION_NORMALIZED` (`Preflight/TextForms.cs`:
`;` no fim de uma declaracao de linha, `client variable`/`site property`/`setting`/`session variable`/`timer`, e `os:DefaultValue=v`
como ultima clausula de uma variavel, que e o `= v` dela, o texto com as aspas; so na linha que o parser recusa ou no os:, e so se a
linha passa a ler), `FLOW_END_AFTER_TERMINATOR` (`end` solto logo depois de `navigate`, `raise` ou `end` na mesma profundidade: a
linha fica em branco, os numeros de linha nao mudam) e `FLOW_ASSIGN_WRITTEN` (linha `Alvo = valor` que a gramatica recusa vira
`assign Alvo = valor`; nunca quando o alvo e um nome solto e o valor comeca como um no, `X = Acao(...)`, que tem duas leituras);
so a linha do erro, uma por vez, mantida so se o parse passa dela. `LITERAL_FOLDED` (`Preflight/LiteralFolding.cs`): default ou
valor de registro estatico escrito como constante (`TextToDate("2026-05-04")`, `NewDate`, `NewTime`, `NewDateTime`, `TextToTime`,
`TextToInteger`, `IntegerToText`, `DateToDateTime`...) vira o literal do tipo do lugar, em toda forma: `set DefaultValue` cru (tipo
do job quando ele declara a variavel), texto de dados, texto de logica (`in`/`out`/`local`), JSON de logica e spec (so chamadas),
documento (`<var>`/`<input default>`); literal de outro tipo com um sentido so tambem (`"2026-05-04"` numa Date) fora do JSON e do
spec (la e o LiteralFix de antes). O que nao e constante (`CurrDate()`) fica como esta: o Studio aceita alguns (html-replay 0162).
`CSS_FUNCTION_REWRITTEN` (`Preflight/StyleSheetNormalizer.cs`, `CssCompat.ResolveMixVars`/`Render`/`MixText`): todo CSS do job
(`set StyleSheet`, `data.css` do html); `light-dark()` de `set StyleSheet` expandido primeiro; `color-mix` com `var(--x)`:
definida uma vez no `:root`/`html`, o valor no lugar; definida em outras regras desta folha (`:root` e `[data-theme="dark"]`, um
escopo `.app`, o `@media` escuro do light-dark), todas as que a chamada le nas mesmas regras e uma vez em cada: uma propriedade
derivada `--x-mix-<hash>` em cada uma dessas regras com a cor de la (o tema escuro e o escopo ficam); um lado `transparent` e a
outra cor com a parte como alfa em qualquer espaco, `oklch(...)` inclusive. Token do OutSystems UI (`--color-` ...), regras
diferentes entre as propriedades ou definicao fora desta folha continuam recusa `CSS_FUNCTION_UNSUPPORTED`. Recusa no mesmo passe com patch provado:
`OPERAND_TYPES` em filtro de aggregate do documento (`Preflight/DocumentAggregates.cs`, C13): identificador ordenado contra numero;
com o tipo do Id conhecido pelo spec do job (estatica Integer, entidade Long Integer) o patch escreve `IdentifierToInteger(X.Id)`
no html como foi mandado, e so sai se a mesma regra nao acha nada no texto corrigido; `verifyCode`/`element` juntam o
`OperatorIncompatibleTypes` do Verify ao mesmo lugar. Cascata (`JobRunner.Cascade.cs`): problema do apply ou do Verify que diz nao
achar (HTML_NAME_UNKNOWN, FLOW_OWNER_UNKNOWN, FLOW_NAME_UNKNOWN, REFERENCE_UNRESOLVED, CHILD_NOT_FOUND, `*Unknown*` do Verify) um nome
que uma parte do job que falhou declara (um texto de logica que nao leu, `*_SYNTAX`/JSON_SHAPE do preflight, ou erro do apply da
parte; nunca so o Verify ou uma regra do preflight, que deixam a parte aplicada) sai dos problemas; a raiz leva
`blocks: N` e `blocked` (os 3 primeiros), transitivo, e o aviso `CASCADE_FOLDED` diz quantos. O check do documento conta como
declarado tambem o que um texto de dados do job declara (`Client.X` de um `client variable` de um spec depois do html).
Provas: `tests/Anvil.Tests/FamilyPreflightTests.cs` (FamilyPreflightTests e FamilyCascadeTests).
Textos `ssam-flow/1` da op `logic` (VisitaCerta 12/10/2026, `Kernel/FlowTextNormalize.cs`, chamado por `JobNormalizer.Pure`):
`FLOW_BRANCH_FALLS_THROUGH`, `FLOW_LABEL_SPACING`, `FLOW_ASSIGNMENT_INDENT`, `FLOW_NEW_ACTION_IDS`, `FLOW_MAPPING_RELATIVE`,
`FLOW_SORT_DIRECTION` (o texto so muda quando o editado le inteiro; com outro erro vai como veio, todo erro e um `FLOW_SYNTAX` da
mesma recusa e os que uma edicao certa remove trazem o patch dela). So o que tem uma leitura: fall-through de corpo de
For Each e fim de fluxo; o if/else sem terminador fica `FLOW_SYNTAX` com as duas leituras (`candidates`), tambem o ramo que
termina num If sem passo falso (reconferencia 12/10/2026); linha de no malformada nunca vira atribuicao (palavras de no em
qualquer caixa, `Source = R` com espacos; funcao embutida como `If(A=1, ...)` nao e chamada); `L.Current` sem forma relativa e
`FLOW_MAPPING_CURSOR` (numa edicao, o que a leitura ja tinha e decidido pelo conteudo, nunca pelo lugar). Na releitura (as
duas faixas, pelos tipos do modelo): `FLOW_MAPPING_PLATFORM` e `FLOW_MAPPING_STUDIO` (este so quando preenche todo atributo
ou leva o registro inteiro: `Value: R` com destino sem atributo `Value` e R registro do item; senao `FLOW_MAPPING_TYPES`, que
tambem nomeia o atributo que a ODC preenche sozinha quando o mapeamento o deixa de fora). ODC: mapeamento escrito sobre um
valor existente vai pelo setter (a conversao inteira), nunca dentro do texto do valor antigo.
Detalhes e provas: `docs/TEXTO-LOGICA.md`, secao "O que o motor normaliza no texto".
Correcao por nome (fachada, `platforms/odc/facade/job-patch.mjs`; o kernel segue recebendo o job inteiro): o patch aceita nomes
no caminho (`actions/<Acao>/steps/<as>/...`; identidade = primeiro texto entre name, as, key, id, label; digitos sao indice) e
`job` parcial + `basedOn` (mesmo nome substitui, nome novo entra; remover so por patch). A fachada gera o job completo, e o
`patch` numerico do kernel volta tambem como `patchByName`. Testes: `platforms/odc/facade/tests/patch-por-nome.test.mjs`.
Velocidade (lote 2, 24/10/2026). `check` pelo worker (S9, `code-check.mjs`, `anvil-worker.mjs`): quando o worker da lane esta de pe,
ocioso e da mesma instalacao, o `apply` do check vai a ele e reaproveita o spare do modulo quente (sha256 do modelo, R3); a resposta
e a do check frio mais `timings {via:"worker"|"process", kernelMs, hot}`; sem worker o caminho frio nao muda. O `write {draft}` da
O11 (R2) oferece o candidato do check conjunto como `--prebuilt` quando captura, job e produtores batem; senao refaz o apply e diz
`draft.prebuilt.candidate {reused:false, reason}`. Leitura quente (S14, verbo `hot-read` do worker): `ssam_map view:flow|digest` le o
spare do modulo no lugar, sem toma-lo, com a mesma resposta da CLI fria (`via:"worker"`); worker ocupado, com fila ou preparando um
spare recusa na hora e a fachada le frio. Leitura seletiva (S10, `ModuleFlow.BuildSelected`): `flow` com elemento, `ssam_code read` e
`ownerReadings` constroem so as actions pedidas, com o mesmo `textSha` da leitura inteira, resposta `partial:true` (nunca gravada como
fluxo do modulo); `search`/`uses` continuam completos; `BuildSignatures` da as assinaturas sem corpos. Caches por op no apply (S12,
`Verbs.Flow`): um indice de nomes de action por op `logic` em vez de um por texto, invalidado pelo que cada verbo cria, renomeia ou
move; `ANVIL_APPLY_CACHES=off` volta ao antigo; candidato identico com e sem cache (`ApplyCacheTests`). Indice de descoberta (S11,
`discovery-index-store.mjs`): persistido em `platforms/odc/.local/discovery/<lane>/` por identidade das fontes (catalogo, fragmentos,
exemplos, CLI, kernel, Studio) e pre-aquecido no arranque atras de `SSAM_NO_WARM`; release so da fachada nao sobe nenhum processo.
Prazos (`call-deadline.mjs`): escritas, publicacoes e leituras longas (`ssam_map`, `o11_inspect`, `studio_inspect`, `o11_environment`)
esperam 50 s antes do `continueTask`; as demais 25 s. Medidas e limites: `docs/BENCH-FRIO.md` e a secao 8 do plano
`docs/PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md`.
Velocidade (lote 3, 24/10/2026). Sondagens nativas em lote (L3a): as duas CLIs aceitam `api --op native --types A,B,...` e respondem
todos os tipos num processo so, cada tipo resolvido entre os assemblies que um processo novo ja teria carregados (saida identica
a `--type`, byte a byte); a fachada constroi `native-<key>.json` pelo lote e volta ao caminho por tipo com uma CLI antiga ou numa
falha (`SSAM_DISCOVERY_NATIVE_BATCH=0` forca o antigo). Primeira descoberta depois de uma release do kernel: ~44 s para ~2,2 s.
Spare apos o merge (L3b): quando a entrega no worker termina `delivered`, o kernel prepara, ocioso e cancelavel, o spare da captura
entregue (`nextSpare` no resultado) e para de preparar o modelo de antes; o verbo `warm` do worker pede spares sem toma-los; no
arranque, atras de `SSAM_NO_WARM`, o servidor pede os spares dos modulos abertos no Studio (sem Studio, as 3 capturas conhecidas
mais recentes) e `ssam_doctor` traz `spares` com quantos estao prontos. Um preparo inicializa o runtime headless antes de carregar;
uma entrega que chega durante o preparo responde sem esperar e o cancela. Medido num modulo O11 de cliente: leitura `flow` pos-merge 7,5 s para
0,15 s; 2a entrega pos-merge `loadMs` 677 para 12 ms; 1a leitura apos subir o worker 7,2 s para 0,3 s.

SQL (`SqlPreflight.cs`, chamado pelo `check-job` e pelo apply): todo SQL do job (logic `get` com `sql:true`, `ISQLNode`
criado no job, `set ... Statement` num no existente) e lido antes do Studio e recusado com `op #N (SQL <onde>, line L)`
e motivo: aspas, colchetes, chaves, comentarios e parenteses desbalanceados; `{Entidade}`/`{Entidade}.[Atributo]` fora
do job, da base e das referencias; `@Param` sem `ISQLInputParameter`; atributo comparado direto com parametro de tipo
incompativel (Text x numero, data x numero, booleano x Text/data, binario; use CAST para converter); Expand Inline que
nao e Text; expressao OutSystems dentro do SQL. So no O11 (SQL Server): LIMIT, ILIKE, `::tipo`, TRUE/FALSE, `==`,
funcoes de outros bancos (NOW, IFNULL, LENGTH...), string entre aspas duplas, virgula sobrando, AND/OR/WHERE sem
condicao, ORDER BY em subconsulta sem TOP/OFFSET (erro 1033). O que depende da base sai em `unresolvedSql` e e conferido
contra a base carregada antes da primeira mutacao. Parametro declarado e nao usado num no cru fica com o Verify
(UnusedElement). Lacunas: semantica do banco (colunas sem `{}`, ambiguidade, GROUP BY, conversoes de valor, mapeamento
para a estrutura de saida, permissoes) continua aparecendo so ao executar; ver `tests/Anvil.Tests/SqlPreflightTests.cs`.

Upgrade do banco (`DatabaseUpgradeRules.cs`, no apply de todo build/deliver, sobre o modelo efetivo base + job, antes de
salvar o candidato): o que a publicacao recusaria e o TrueChange deixa passar e recusado com `op #N (<verbo> Entidade.Atributo)`
e a troca exata. So no O11 (SQL Server): Delete Rule Delete e `ON DELETE CASCADE`, e o banco recusa uma tabela alcancada por
dois caminhos de cascata (duas FKs Delete da mesma tabela para a mesma tabela contam como dois) ou um ciclo de cascata (erro
1785; na publicacao "Could not create foreign key constraint ... circular dependency between entities"). A recusa lista as
referencias a trocar para Ignore ou Protect (primeiro as do job, depois a que resolve mais conflitos, depois o ultimo salto
do caminho mais longo): aplicar todas sempre passa. O ODC (PostgreSQL) aceita os dois casos e nao recusa. Nas duas faixas:
entidade com mais colunas do que o banco aceita (1024 SQL Server, 1600 PostgreSQL). Auto-referencia com Delete, indice com
Text > 2000 ou Binary e FK para extensao ja sao erros do TrueChange. Fora (dependem das linhas que ja existem): valores
orfaos sob FK nova, duplicatas sob indice unico novo, conversao de tipo ou reducao de Length. Negativo
`data-cascade-multiple-paths.json`; testes em `tests/Anvil.Tests/DatabaseUpgradeRulesTests.cs`.

Acesso a dados (`QueryInLoopRule.cs`, `AggregateConsolidationRule.cs`, chamados no fim de `ModelSession.Apply`, sobre o
modelo candidato, nas duas faixas; decisao do dono 2026-10-09): Aggregate ou SQL no corpo de um laco (ForEach, ou ciclo de
If que volta; os lacos sao as componentes fortemente conexas do fluxo) que o job criou ou mudou, ou dentro de um laco que o
job criou, e recusado com `QUERY_IN_LOOP` (op, ponteiro do passo, `flow`, `loop`, `query`, `fix` e `suggestion` com o
aggregate com join antes do laco e o `ListFilter` dentro dele quando derivavel), junto com as outras falhas do apply.
Escape: `"allowQueryInLoop": {"why": "<15+ caracteres>"}` no op (aceito em qualquer verbo de escrita, `VerbSurface`), vira
`QUERY_IN_LOOP_ALLOWED` no recibo. Laco legado num fluxo tocado: aviso HIGH. `AGGREGATES_MERGEABLE`: aggregates do mesmo
fluxo/tela, mesma entidade ou ligados por FK, lidos juntos: aviso HIGH (a HIGH warning for a semantic review, with no
replacement operation; a relation between entities does not prove that authorization, locks, intermediate reads, paging,
totals or cardinality are equivalent; the warning never allows joining filters with OR or removing filters that use an
earlier query). Os avisos HIGH vao
para `highWarnings` do recibo do apply; a entrega O11 (`Delivery.cs`) e a fachada os poem primeiro em `warnings` e em
`highWarnings`. Limites: fluxos que o job nao tocou nao sao lidos; a origem do no e o op que o criou (ou o primeiro op que
cita o fluxo). Testes: `tests/Shared/QueryRulesScenarios.cs` (O11 e ODC).

Checagem de compilacao (`CompileCheck.cs`, no fim de `ModelSession.Apply`, ao lado do QUERY_IN_LOOP, nas duas faixas; decisao
do dono 2026-10-12: erro de publicacao = o SSAM deixou construir o que o OutSystems nao suporta; tudo que sai "entregue" tem de
compilar). Toda regra e ERRO (nenhuma e aviso): uma recusa so com todos os problemas (phase apply, op, ponteiro do passo, fix,
patch verificado quando e certo), antes do Verify e de salvar. `AGGREGATE_SORT_NOT_ATTRIBUTE`: sort nao dinamico que nao e UM
atributo de uma fonte do aggregate nem uma coluna dele (o compilador quebra em AttributeSort, "Dump is not a valid invocation
for SQLCallFunction" ou NRE em Old_IsDynamic); num aggregate que agrupa (GROUP BY ou AGG), so um atributo que o GROUP BY le
(`Fonte.Atributo`, ou a coluna CALC agrupada pelo nome): o sort vive antes do agrupamento (coluna agrupada ou agregada ali da
"Can't identify" no Verify) e o SQL so ordena linhas agrupadas pelo que o GROUP BY da (erro 8127); sem patch (qualquer troca
muda as linhas ou a ordem), o fix lista as chaves. `AGGREGATE_COLUMN_NOT_ATTRIBUTE`: GROUP BY/AGG sobre expressao (o mesmo
slot que quebrou o sort); patch no texto quando e certo: `CALC NomeRow=<expr>` e a coluna pelo nome (`GROUP BY Nome=NomeRow`,
`AGG Nome=Fn(NomeRow)`, a forma publicada de dois modulos O11 de clientes), coluna nomeada, funcoes que o banco roda, linhas lidas campo a
campo; o prototipo ja escreve `CALC TotalRow=A.Qtd * B.Preco` + `Sum(TotalRow)`. Coluna que nao le atributo nenhum (texto
`AGG Total=Count()`, JSON `"attribute":""`, create cru sem set, `set Attribute ""`: sem DataType; o Verify O11 so pega se algo le a
coluna) tambem e recusada: o parse recusa `Fn()`; Count com uma fonte so tem patch certo `Count(Fonte.Id)` (o modelo diz o
identificador; no ODC o texto nao escreve agrupado, o fix aponta o op logic). `AGGREGATE_JOIN_NOT_NATIVE`: join que nao e
Inner/Left/Full (os tres do Studio), join com fonte de OUTRO aggregate ou a mesma fonte dos dois lados (verbo cru; a Model API do
ODC recusa essa escrita), ou fonte de um aggregate de varias fontes que nenhum join liga; `JOIN Right A~B`, unico
join de duas fontes, e escrito `JOIN Left B~A` no texto e no logic (listado: `AGGREGATE_JOIN_NORMALIZED`); verbo cru com Right e
recusado. `COMPILE_REFERENCE_OUTSIDE_MODULE`/`COMPILE_REFERENCE_DELETED` (propriedade que aponta para fora do modulo e das suas
References, ou para elemento apagado). `COMPILE_SOAP_DEFINITION`: servico SOAP consumido so nasce da importacao nativa do WSDL
(op soap pelo o11_deliver); cliente, metodo ou structure SOAP criado pelos verbos do job, ou WSDL/MetaData escrito por set cru,
e recusado com a chamada exata (`suggestion`: `{"op":"soap","data":{"wsdl":...,"client":...,"methods":[...]}}`; ODC: SOAP nao
existe, REST ou External Library). O candidato de 09/10 feito assim falhou no compilador ("Root element is missing"). Lab que
mede os verbos SOAP declara `allowSoapWithoutImport {why >= 15}` no create do cliente: aviso HIGH
`COMPILE_SOAP_DEFINITION_ALLOWED`, e a entrega (Delivery.cs e a fachada ODC) recusa esse job. Base que ja nao compila: as regras
de aggregate rodam tambem em todos os aggregates do modulo que o job nao escreveu (andando a arvore sem widgets, expressoes,
entidades e structures: ate 0,3 s nos maiores modulos do corpus e das capturas de campo) e o que acharem recusa a entrega marcado `preexisting`, com os
ops crus por @key que corrigem quando e certo (anexados ao job como patch). Motivo: nenhuma entrega sobre essa base compila (a
publicacao de 15:50 do VisitaCerta_CS falhou em dois sorts If que aquele job nao tocou). Job so de leitura nao e
julgado. As classes C (dois caminhos de cascata) e B (XIF sem DLL) ja sao recusadas por `DatabaseUpgradeRules` e pela regra do
XIF. Os escritores escrevem o sort como o Studio (`AggregateSortRule.cs`): `X DESC`, `-X`, parenteses, conversao que guarda a
ordem (`IdentifierToLongInteger(X)`) e `If(C, 0, 1)` viram o atributo com a direcao, no texto (`FlowDiff.Sorts.cs`, antes do
diff; chave repetida depois disso sai e e listada) e em todo `set` de `ISort.Attribute` (so quando o atributo esta no escopo
do aggregate); tudo em `expressionRewrites` e `notes` (`AGGREGATE_SORT_NORMALIZED`). O resto e recusado com o fix: coluna
`CALC SortKey=<expr>` e `SORT SortKey` (patch no texto quando e certo: sem GROUP BY/AGG, funcoes que o banco roda, linhas lidas
campo a campo), ou sort dinamico.
CLI: `anvil compile-check --oml <captura>` (e `anvil-odc`) roda as regras no modulo inteiro e conta a andanca dos aggregates:
zero achados e a mesma contagem de aggregates nos 34 modulos do corpus (`C:\t\html-plan\unique.json`: 840 mil objetos, 1.437 aggregates,
432 sorts, 144 colunas, 569 joins) e nas 61 capturas de campo (986 mil objetos, 2.265 aggregates), os 3 sorts ruins na
captura da sessao VisitaCerta_CS 154543. Testes: `tests/Anvil.Tests/CompileCheckTests.cs` e `tests/Anvil.Tests.Odc/CompileCheckOdcTests.cs`.

Regressao do motor: `performance-lookup.json` prova tipos compartilhados e chamada de action declarada adiante.

Resumo do modulo (`Kernel/ModuleDigest.cs`, `ssam-digest/1`; uso em `docs/LEITURA-RAPIDA.md`): o modulo inteiro como texto,
lido so por `ModelReader` (O11, ODC e o builder compilam o mesmo arquivo). Fica ao lado do indice do modulo
(`ModuleIndexStore.SaveDigest`, `<sha256>.<adaptador>.digest.json`), pedido ao leitor residente por `{"digest":"ensure"}`
(`SnapshotReadCache.EnsureDigest`) ou pela CLI fria `anvil digest` / `anvil-odc digest`. No ODC o leitor e o `anvil-odc
read-serve` (kernel), nunca o builder. Manutencao: toda mudanca no texto sobe `ModuleDigest.Extractor` e `DIGEST_EXTRACTOR`
de `platforms/odc/facade/module-digest.mjs` (o teste da fachada confere os dois); arquivo de outra versao e falta. Tipo
novo que o resumo nao desenha aparece em `not rendered` da cobertura: desenhe-o, ou dobre-o com motivo, ou marque-o como
valor de um dono desenhado (`ValueKinds`). Os ultimos registros de um bloco de estatica sao `DigestEntry.Records`: mantenha-os
no fim, uma linha cada. Testes: `tests/Shared/ModuleDigestTests.cs` (as duas faixas) e
`platforms/odc/facade/tests/module-digest.test.mjs` (paginas, cache, `view`, captura fixada pelo sha).

Texto de dados (`ssam-ddl/1`; uso em `docs/LEITURA-RAPIDA.md`). A ida e `Kernel/DataDdl.cs`, `ssam_map view:"ddl"`, com o
ponto fixo provado por `DataDdlParser.cs` e `DataDdlCheck.cs`. A volta e a op `spec` com `data.ddl`:
- so as declaracoes que mudam, como lidas, com o `-- @key`;
- sem chave e novo; mesma chave com outro nome e `rename`;
- atributo ou registro fora de uma declaracao enviada inteira e apagado; `drop ... -- @key` apaga.
- com `basedOn` (obrigatorio com `-- @key`: `DDL_BASE_REQUIRED`), merge de 3 vias com a leitura guardada
  (`Kernel/DataDdlMerge.cs`): o que o Studio acrescentou depois da leitura fica, conflito fica com a entrega e vai em
  `merged.conflicts`; sem a leitura, declaracao que difere do modulo e recusada (`DDL_BASE_UNKNOWN`, com `edit` pronto);
  o recibo traz `nextBasedOn`. O texto de logica faz o mesmo (`Kernel/FlowMerge.cs`, partes de um no uma a uma;
  `FLOW_BASE_REQUIRED` sem `basedOn`; leitura em `<sha>.kernel.flow-<textSha>.json`, gravada pela fachada ao servir a
  action e pelo job). Baterias: `anvil ddl --merge-battery` e `anvil flow-merge-battery`.

`Kernel/DataDdlCompile.cs` (puro) compara o texto com o do modulo. Tipos novos viram `spec`; o resto vira verbos crus.
`Kernel/Verbs.Ddl.cs` aplica, le o modulo de novo, regrava o que a plataforma reescreveu e recusa com
`DDL_NOT_CONVERGED` se sobrar diferenca. Recusas com a linha, todas de uma vez. Nunca reescreva o texto sem passar pelo
ponto fixo da DL1.

O que a plataforma preenche sozinha (`Kernel/DataDdlConventions.cs`, puro, antes da primeira volta e nos checks
estaticos do job): o identificador e sempre required; identificador de estatica nunca e auto (salvo o que o modulo ja
tem); valor omitido de registro de estatica (identificador Integer, atributo do label, do order, todo required) fica com
o do modulo no registro mantido, ou ganha a convencao no novo (proximo Id livre, o nome, a posicao, o default), senao
`DDL_VALUE_REQUIRED` com a linha; indice em estatica sai com nota (unique repetido: `DDL_STATIC_INDEX_DUPLICATE`);
atributo do label/order de estatica mantida fora da declaracao, com valores nos registros: `DDL_STATIC_ATTRIBUTE_LEFT_OUT`
com o patch (a linha como foi lida); apagar e escrever `label none` / `order none`. O
texto completado e o mesmo em toda volta (nenhuma volta limpa o que a outra escreveu). O contrato de dados conta como
prova cumprida a assercao cujo endereco passa por um elemento que o job apagou (`DataAssertions.PassaPorApagado`).
Testes: `tests/Shared/DdlConventionsTests.cs` e `DdlConventionsNativeTests.cs` (corpus nas duas faixas e os jobs da
sessao de 2026-10-12 em `tests/text-corpus/session-20261012-static.json`).

Testes: `tests/Shared/TextRoundTripDataBackTests.cs` (puro) e `TextRoundTripDataBackNativeTests.cs`, com o corpus:
- a bateria `DdlBattery`, `anvil ddl --battery --manifest <manifesto do corpus em tests\text-corpus>`;
- o rename;
- o pedido do transcript.

Indice rico (`Kernel/ModuleRichIndex.cs`, `ssam-rich-index/1`; uso em `docs/LEITURA-RAPIDA.md`, `ssam_map` views `search`
e `uses`): por elemento, as propriedades com valor, o texto de toda expressao, os argumentos das chamadas e as referencias
(por propriedade e pelo grafo nativo `ReferrersOf`). Lido so por `ModelReader`; O11, ODC e o builder compilam o mesmo
arquivo. So sob pedido: `{"rich":"ensure"}` no leitor residente (`SnapshotReadCache.EnsureRich`) ou a CLI fria
`anvil rich-index` / `anvil-odc rich-index`; nada mais o constroi. Fica ao lado do indice
(`ModuleIndexStore.SaveRich`, `<sha256>.<adaptador>.rich.json`). Identidade entre modulos: a `GlobalKey`, gravada so
quando nao e a do proprio modulo (assinaturas sob uma `Reference`). Manutencao: toda mudanca do arquivo sobe
`ModuleRichIndex.Extractor` e `RICH_EXTRACTOR` de `platforms/odc/facade/module-rich.mjs` (o teste da fachada confere);
propriedade nova que so pesa (contabilidade do modelo, descritor) entra em `Skipped`, medida nas fixtures. Testes:
`tests/Shared/ModuleRichIndexTests.cs` (as duas faixas; um consumidor -> o seu produtor, as duas fixtures O11 do kernel, pela `GlobalKey`) e
`platforms/odc/facade/tests/module-rich.test.mjs` (search, uses dentro e entre modulos, construcao sob pedido, paginas).

Tela como HTML (`Kernel/ScreenHtml.cs` e `Kernel/ScreenHtmlModule.cs`, `ssam-html/1`; contrato em `docs/SSAM-HTML.md`,
`ssam_map` view `html`): a fonte de uma tela ou bloco, com `k` por elemento, expressoes como texto, os dois ramos de todo
If, eventos com destino e argumentos, `os-<Propriedade>` para o resto e `os-opaque` para tipo sem linha. Lido so por
`ModelReader`; O11, ODC e o builder compilam os mesmos arquivos. A leitura do modulo (um passeio, sem o corpo das
actions) fica com a captura no leitor residente (`IReadSnapshot.ReadHtml`, `{"html":"<tela>"}`); a tabela `k -> ObjectKey`
fica ao lado do indice (`ModuleIndexStore.SaveHtmlKeys`, `<sha256>.<adaptador>.html-<htmlSha256>.json`). CLI fria:
`anvil html-read|html-check|html-census` (e `anvil-odc`). Padroes: os do Studio instalado (`ScreenDefaults`), medidos uma
vez por identidade do Studio e contexto (o modulo e o tema do fluxo de UI da pagina: tipo do modulo e grid do tema decidem
parte do que um elemento novo nasce; cada pagina le com os padroes do seu fluxo; `StudioBornValues`: elementos novos criados
num fluxo novo de uma copia descartavel do proprio modulo, com o tema do contexto, nunca no "primeiro" fluxo do modulo;
`StudioDefaults`: cache por usuario em `%USERPROFILE%\.ssam-hybrid\studio-defaults`, `SSAM_STUDIO_DEFAULTS_ROOT`); nunca uma
tabela de valores no kernel. Sem medida (modulo sem pagina), a leitura diz o motivo e a escrita recusa `HTML_STUDIO_DEFAULTS`.
Exception: an attribute of the language left out means what the language says, never what the Studio gives a fresh
element (`ScreenDefaults.LanguageDefault`): `mandatory` of `<input>` and block `<event>` False, `required` False, `enabled`
True, `size` of `<i>` FontSize, the join of an aggregate (`join=`, `os-Join` without `os-JoinType`) Left. ODC Studio
1.7.28.10873 and Service Studio 11.55.87 create inputs and block events mandatory, an Icon Twotimes and a Join Inner: the
writer sets the language's value and the reading writes the attribute only when it holds another one (`mandatory="True"`).
Mudou o que a receita cria: sobe `StudioBornValues.Recipe`. Manutencao: toda mudanca do texto sobe `ScreenHtml.Extractor`;
colecao do Model API sem ordem estavel (actions, eventos, argumentos, partes de aggregate) entra em ordem canonica
(`ChildIndexes`), nunca na ordem da carga. Testes: `tests/Shared/ScreenHtmlTests.cs` (as duas faixas),
`ScreenHtmlCoverageTests`/`ScreenHtmlCoverageOdcTests` (ponto fixo no corpus do plano com os pisos da secao 4.2; o
manifesto fica em `tests/contracts/screen-html/`, capturas por caminho absoluto e nunca no repositorio; sem elas, pula
com aviso)
e `platforms/odc/facade/tests/module-html.test.mjs`.
A volta (C2): a op `html` na forma edicao `{screen, basedOn {capture, html}, edit:[elementos com k] | html}`
(`ScreenHtmlEdit.IsEdit`; `Verbs.ScreenHtml.cs`) planeja a diferenca por `k` contra a leitura da tela no modulo do job
(`ScreenHtmlModule.Edit.cs`: juncao, todas as recusas de uma vez, escrita pelos verbos `create`/`set`/`rename`/`delete`/
`move`, conferencia que rele a tela e exige o texto editado com as ObjectKeys do que ficou). Nunca usa o `HtmlDelta`, que
limpa e recria. Tela que mudou desde o `basedOn`: merge de 3 vias com o texto daquela leitura (`ScreenHtmlMerge`, base =
leitura, local = tela agora, estrangeira = base com a edicao; conflito fica com a entrega e vai em `rebased[].conflicts`).
CLI fria: `anvil html-edit` e `anvil html-edit-battery`. Testes: `tests/Shared/ScreenHtmlEditTests.cs` (as duas faixas,
regras e merge), `ScreenHtmlEditJobTests` (job O11, rebase, os 2 pedidos de correcao do transcript de 2026-10-10 e a
bateria no corpus) e `ScreenHtmlEditBatteryOdcTests`; a bateria (`ScreenHtmlEditBattery`, secao `c2` do manifesto) exige
100% das edicoes sinteticas relidas iguais.
The native look of the document form (CX17, `ScreenVisual*.cs`, `Verbs.ScreenDocument.Visual.cs`): a new widget without
`class` is born with the Studio's class (controls) or with it minus the ornament (`form`, `list`), table
`ScreenVisual.ClassDecisions` checked against `PrototypeWidgetDefaults.Table`, one rule (`ScreenVisual.StudioClassOf`) in the
forms that create a widget without `k` (document, `html`/`edit`/`edits` of a reading, fragment `parent`; not the page form: D1
of 2026-10-17); a new List of `thead|tbody|tfoot|ul|ol` or of a grid/flex box gets `disable-virtualization`; the theme the
page shows (its flow's, else the module's default: `PageThemeOf`, review 3, M7) carries `/* ssam:native-layout */` (versioned, once; a theme of another module takes none, so nothing is marked and
the notes say why: `THEME_NATIVE_LAYOUT` `written:false`, `GUTTER_ADDS_TO_GAP`),
but every rule needs a marker `data-ssam-gap|page|rows` the op writes only on an element it created, so a screen the op did
not create keeps its CSS (review 1, A1); the page marker goes only on a screen of the op, never in a block (a block goes on
pages the op did not create); the markers are the engine's: `ScreenVisual.AuthorMarkers` is the one rule the document, edit
and fragment forms call, an author's marker is `HTML_RESERVED_MARKER` with the patch that removes it, an element with `k` may
carry the one its reading had, and `otherRootsAffected` is measured on the markers of the other roots (review 2, M4); the gutter is
zeroed only after a neighbor whose flex or grid parent has a column gap that is not 0, read once by
`ScreenVisual.SpacingReader` (per axis, the cascade, OutSystems UI's layout utilities, the conditions said in the note; review
2, M5, over the themes the page shows); the markers are derived state (review 3, M6): the document form decides them on every widget
it compiles, with or without `k` (the `k` keeps Visible, JavaScript and JSON, never a marker as written), and the edit forms decide
the gap marker again on every link, button and form of a screen of the op (its reading carries a marker; a screen of the Studio
carries none and nothing is marked), `HTML_MARKER_DECIDED` saying each change on an element with `k`; a block is decided on the
themes of the screens that place it (`RootThemeOf`, review 4, N1: pages of another module named in `pagesWithoutBlock`, two
themes of this module that disagree are `HTML_BLOCK_PAGES_DIVERGE`), and every edit of a page that carries markers puts the block
in the theme it shows now or removes the markers where no theme carries it (review 4, N2); everything in `normalized`,
in every job. `ScreenVisual.Predict` predicts the runtime
DOM from `RuntimeDomTable` (no layout) and `ScreenVisual.Check` (static; today only the document form calls it) returns the warnings
`HTML_SELECTOR_MISSES_RUNTIME`, `HTML_THEME_TOKEN_SCOPED`, `HTML_TEXT_JOINED` and `HTML_LIST_NOT_LAYOUT_CONTAINER`, one per
family per job, after the data and owner-rule warnings (`ReceiptFields` orders them; the facade says `highWarningsTotal` when
it cuts at 10), with the checked patch in `suggestion`. Tests: `ScreenVisualFamilyTests`, `ScreenVisualPredictTests`,
`ScreenVisualCheckTests` and `DemoLatamVisualTests` (copies outside the repository; skipped without `SSAM_DEMOLATAM_DIR`).

## Dados: uma spec, uma entrega e uma prova

Registros de negocio ja publicados: `ssam data --lane o11` / MCP `o11_data` usa o cliente nativo
Edit Data em processo headless, com credencial privada e recibos por operationId. Nao criar actions/timers
para seed quando esse caminho atende. Contrato e prova: `../docs/O11-DADOS-HEADLESS.md`.
Sem `--host` e sem `--credentials` (ou com `--studio`), `anvil data` usa o Studio ja logado da faixa (SSO incluido),
sem credencial, pelas operacoes `data-read`/`data-write` da bridge (`EnvironmentData`).

Para tabelas relacionadas, use uma unica op `spec` com `static`, `entities` e `structures`. O compilador declara todos
os tipos e seus identificadores antes dos campos: a ordem entre entidades da mesma spec nao exige entregas separadas,
inclusive com FKs circulares. O caso completo provado e `hire-data-model.json` (65 entidades, 46 static, indices);
`api --op spec` informa as chaves. Nao expanda manualmente static entities que a spec ja suporta.
`attributes` de static aceita configurar `Label` existente; `records` aceita valores dos atributos adicionais como
expressoes OutSystems. `updateBehavior: "Optimized"` corresponde a Changed Attributes e e o padrao de toda entidade de
servidor criada pela spec (o Studio o sugere para muitos atributos, Binary Data e texto longo); declare `updateBehavior`
so para outro valor (ex. `"Full"`). `indexes` da entidade aceita
`{"name":"IX_Status","attributes":["StatusId"],"unique":false}`; nomes sao atributos da propria entidade, em ordem.
`type: "Long Text"` em atributo de spec gera `Text` com Length 2000000 quando o pedido nao define outro comprimento;
nao e um tipo primitivo do Model API. Nos verbos crus, use DataType Text e Length explicitamente. Comprimento omitido
em Text simples continua sendo o padrao do Studio; nao prometa texto longo sem prova do comprimento.

`check-job` verifica referencias a tipos declarados adiante no mesmo job, enums conhecidos e comprimentos invalidos,
e devolve os erros independentes juntos. Tipos que podem vir da base aparecem em `unresolvedTypes`: isso NAO comprova
que existem. O apply confere os tipos externos contra a base antes de mutar quando nao ha importacao de referencias
pendente; com `reference`, a resolucao final depende do produtor carregado. `api --name <Enum>` lista valores aceitos;
a consulta de uma interface tambem inclui `enumValues`. Nao adivinhe o texto do menu como nome do enum.

`deliver` guarda hashes do job, partes e produtores job:, verifica as propriedades declaradas dos dados no modelo gerado,
faz um merge e tira um snapshot posterior. O `dataProof` compara existencia, nomes, tipos, comprimentos, obrigatoriedade,
valores de registros e indices com a declaracao executada. Falha nessa prova impede `delivered=true`, mesmo com Verify
sem erros. E prova dos dados declarados no job, nao interpretacao automatica da especificacao em linguagem natural.
Use `dataContract.dataSummary` no apply ou `dataProof.dataSummary` no deliver para conferir a especificacao:
traz tabelas, campos com tipos legiveis/comprimentos/obrigatoriedade, valores dos records e colunas dos indices.
Esse resumo ja vem da leitura do modelo; nao e preciso acrescentar get/dump para cada campo ao job de criacao.
O run_job.py grava o resultado integral ao lado do OML, com sufixo .result.json, e imprime esse caminho; leia-o sem reaplicar.
Antes de confirmar conclusao, use `anvil check-delivery --result <pasta-da-entrega>/result.json`: exige entrega bem-sucedida
e arquivos ainda iguais aos da prova. Se o job mudou depois do merge, a edicao NAO esta entregue. Esse comando verifica
o recibo e seus arquivos locais; nao comprova que nao houve edicao manual posterior no Studio. Nao declare campos,
indices ou integracoes que nao aparecem na prova. A receita testada e `hire-data-model.json`.

## Criacao inicial de aplicacao e modulos

Use uma chamada `anvil create-app --name <App> --kind Reactive --modules <App>_CS:Service,<App>_UI:Reactive --out <pasta>`
(entrada publica: `ssam create-app --lane o11 ...`). Para acrescentar modulos, `anvil add-modules --app <App> --modules <lista> --out <pasta>`.

**Autenticacao: o Studio ja logado, inclusive SSO.** Sem `--credentials`, `inventory`, `download`, `create-app`,
`add-modules` e os demais comandos de ambiente usam o Service Studio da faixa ja autenticado (bridge 4516 no SS4, 4536
no SS5; `--bridge-port` sobrepoe): o CLI pede um lease `environment_session` e cada chamada ao servidor e executada
DENTRO do Studio, com a sessao dele (`ConnectedEnvironment` -> `EnvironmentSessionHandler` -> `EnvironmentOperations`).
Nenhum segredo sai do Studio; `--read-only` continua recusando escrita; resposta perdida de uma escrita nao e repetida.
Ambientes com "SSO login is mandatory" recusam o caminho antigo; `--credentials <arquivo>` fica so para ambientes que
ainda aceitam usuario e senha. Operacoes atendidas pelo Studio: ver `EnvironmentOperations.Names`; outra chamada ao
servidor falha com `NotSupportedException` explicita (sem NullReference). Prova, operacoes cobertas e lacunas:
`docs/proofs/2026-09-25-o11-connected-environment.md`. Com lease read-only o proprio cliente recusa as operacoes de
escrita (`ConnectedEnvironment.WriteOperations`); `anvil signature` so abre esse lease e recusa `--credentials`.
Esses comandos criam a casca da aplicacao, preparam e verificam TODOS os novos modulos, e iniciam todas as publicacoes
antes de esperar os resultados. Nao chame create-module e espere publicar repetidamente para criar um conjunto.
A preparacao do modelo usa a thread unica do runtime; os jobs de publicacao se sobrepoem no servidor. O template e
baixado uma vez por lote. E o fluxo de criacao inicial, sem referencias entre os novos modulos do lote.
Falha de preparacao impede todos os novos envios. Falha de publicacao retorna o resultado de cada modulo, sem rollback
ou repeticao automatica: confira a versao se a resposta for incerta. `ok`/`Succeeded` so sao true com sucesso confirmado;
`PreparationMs`, `PublishStartOffsetMs` e `Publish.TotalMs` permitem medir o lote. Modulos existentes na mesma app sao
preservados (`Skipped`); nomes duplicados ou de outra app sao recusados. A publicacao aqui cria os modulos iniciais;
as alteracoes de produto continuam pelo fluxo deliver, com publicacao pelo humano.

## 0. O laco, sempre o mesmo

1. **Base**: um OML. Para provar, um fixture de `tests/fixtures` (`blank-service.oml` = modulo Service; `reactive-ui.oml`;
   `mobile-ui.oml`; `traditional-ui.oml`). Para entregar, o snapshot do modulo aberto no Studio (`anvil deliver` faz isso).
2. **Job**: um JSON `{"description","base","expectValid":true,"expectedMessages":[],"ops":[...]}` em `tests/jobs/`.
   `base` e o fixture ou `job:<outro-job>` (aplica esse antes; procura em `tests/jobs/`). Ops sao os verbos da secao 2.
   O job pode viver noutra pasta (o caminho e explicito no comando); `ok=False` na saida = o verbo falhou e nada foi salvo.
   Um job = um ficheiro: corrija o MESMO ficheiro (o git guarda as versoes); tarefa diferente = nome pela intencao. Nomes com
   sufixo de versao (`-v2`, `_v3`, `(1)`) sao recusados pelo runner dentro de `tests/` (`job 'x-v2' has a version suffix ...`).
   O OML resultante fica em `.local/jobs/<job>.oml` (para inspecionar com `find`/`dump`; outro job usa `job:<nome>`).
   No JSON, `base` e `producer` aceitam somente fixture em `tests/fixtures`, `job:<nome>` ou nome de snapshot ligado no comando
   (`--producer Headless_CS=<snapshot.oml>`, repetivel). Caminhos `.local`/OMLs mutaveis no JSON sao recusados. `--base <snapshot.oml>`
   explicito sobrepoe o campo `base` para entrega; sem ele o C# resolve a base. Cadeias e compostos resolvem cada fonte na pasta
   do job que a declara, depois em `tests/jobs`; produtores ficam em `<work>/producers/<corrida>/`, sem cache entre corridas.
   `tests/archive/` guarda jobs de entregas passadas que ja nao correm nesta maquina (a base deles era um arquivo de
   trabalho em `.local`, ou um snapshot de produtor que o repositorio nao guarda): e historico, nao prova. Nenhum teste
   varre essa pasta; nao copie de la sem reconferir a base. O que vale como exemplo esta em `tests/jobs`.
   Job COMPOSTO: `{"base": ..., "jobs": ["job:parte-1", "job:parte-2", ...]}` concatena os ops das partes na ordem dada, numa
   unica transacao (o `base` das partes e ignorado). E assim que um app inteiro se entrega com UM merge: `tickets-all.json`
   (8 partes, 3.131 ops). Mesma lista de partes = mesmos ops, sempre.
3. **Aplicar e verificar**: `python scripts/run_job.py tests/jobs/<job>.json` (se o CLI ainda nao estiver instalado, ou apos mudar C#: `python scripts/build.py`,
   que para o worker, constroi o CLI da faixa e volta a subi-lo; `dotnet build` solto falha com o worker de pe). Se vai correr varios jobs, suba o worker residente uma vez
   (`python scripts/anvil_worker.py start`): o mesmo comando passa a correr em processo quente (apply de 5 s -> 0,4 s num job
   pequeno; a saida diz `via worker`); depois de um build faca `anvil_worker.py restart`. Leia a saida: `ok=True` e `isValid=True`; cada mensagem vem como
   `Severity Id: Titulo @ caminho`; o caminho usa o Name de cada dono, o Label quando o no nao tem Name (If, Assign, Switch)
   e o texto quando e uma expressao (`... / CalculaCauda (AssignNode) / Assignment / Expression "Right(Value, 1)"`). Depois das
   mensagens vem linhas `Hint UnknownFunction: 'X(' nao existe ...; parecidas: A, B` (checagem deterministica contra o catalogo
   de funcoes do Studio, antes de voce ler o Verify). Erro = corrigir (secao 4). Warning novo nao bloqueia (A03): volta como
   `nonblocking` (na entrega, em `warnings` com id, path e fix). So bloqueiam os de seguranca (`SecurityWarnings`) e o anonimo abaixo.
   Excecao: o warning especifico de Anonymous Role (CustomObjectWarning sobre expor Server Action sem autenticacao)
   nao bloqueia; fica visivel em `tolerated`. Outros CustomObjectWarning e erros continuam sujeitos ao contrato.
   Essa tolerancia nao altera roles nem substitui a autorizacao das actions no servidor.
   Contrato de mensagens (opcional): `expectedMessages` lista apenas mensagens NOVAS: `{"id":"UnusedElement","element":"Tabs1_OnTabChange (ScreenAction) / TabsId (InputParameter)","why":"Parametro do contrato do evento nao usado neste exemplo"}`.
   `element` e o caminho exato mostrado pelo runner ou um sufixo de um nivel ou mais (o nome antes de ` (` basta); se houver
   empate, vira `ambiguous` com os candidatos: inclua mais pais. Com `"all":true` o `element` pode faltar: cobre toda mensagem do id.
   Os ids vem do kernel que roda (pasta do assembly), nunca so da pasta do job ou do cwd; sem lista, so a forma e conferida e o
   recibo traz a nota `VERIFY_IDS_UNCHECKED`. Um erro de `expectedMessages` e problema do preflight (`EXPECTED_MESSAGES_INVALID`,
   ponteiro `/expectedMessages/<i>`), junto com os outros. `set <Tela> AnonymousAccess true` (ou `Roles` com Anonymous) declara
   a familia anonima da tela inteira (`anonymous-declared-by-job`; o recibo lista `anonymousExposure`); tela ja anonima na base idem.
   `why` e obrigatorio. O campo numerico antigo foi removido. Expectativa sem mensagem correspondente tambem
   falha (`missingExpected`); corrigir um aviso nao compensa criar outro. Mensagens preexistentes nao precisam ser declaradas.
   `validation` devolve `new`, `fixed`, `preexisting`, `unexpected`, `missingExpected`, `ambiguous`; `accepted` exige contrato
   satisfeito e `isValid == expectValid` (padrao true). O apply salva para diagnostico mesmo se `accepted=false`; `run_job.py`
   devolve exit 1 e `proof_merge.py` recusa o merge. Exemplos: `undeclared-warning.json` (aceito, aviso nonblocking) e `stale-expected.json`.
   Cada parte de composto mantem seu contrato para rodar isoladamente; o composto avalia so a sua propria lista, sem heranca.
   Fase scope (R1, 24/10/2026, `Preflight/ScopePhase.cs`): com a base carregada e antes do primeiro op, cada nome que o job usa e
   resolvido contra o dono (tela ou bloco da base, o que o mesmo job declara antes, o modulo e as referencias, os reference
   ops): CALL_UNKNOWN (acao chamada, navigate, destino de evento), SCOPE_UNKNOWN_IDENTIFIER (raiz de expressao de set cru),
   HTML_NAME_UNKNOWN com rule HTML_NAME_RESOLVED (block, handler, destino do documento: as regras S1-S7 do check estatico
   sobre um indice fresco da base), WIDGET_REQUIRED_PROPERTY (Button/Link sem destino), WIDGET_PROPERTY_VOCABULARY (set que
   um elemento do mesmo tipo na base nao escreve), ACTION_KIND_NODE (widget de outra familia ou filho que o pai recusa,
   pelos mapas `docs/mapa/criar-*.json`), REFERENCE_ELEMENT_UNKNOWN/REFERENCE_NOT_PUBLIC (elemento do produtor). Um op raiz
   recusado (preflight ou scope) nomeia os ops que precisam do que ele declara (SCOPE_BLOCKED_BY_REFUSED_OP, `blockedOps`):
   eles nao mudam. Cada problema: phase scope, rule, predicts (o codigo que o apply/Verify daria), fix e patch quando certo.
   Normaliza com nota: OWNER_CHILD_CREATED (filho que o widget nao traz, ex. ITextWidget de um ILinkWidget Traditional),
   IF_CLASS_MOVED (class de um elemento com if= em Reactive/Mobile vai para um container do que ele mostra).
   Com problema de scope, nada chega ao apply: a recusa traz preflight + base + scope (verifyRan false) e o recibo aceito traz
   `timings.scopeMs`. `ANVIL_SCOPE_PHASE=off` e so interruptor do operador. Testes: `ScopePhaseTests` (O11), `ScopePhaseOdcTests`
   (ODC), `ScopeStopTests`; medicao: `ScopeCorpusTests` (desligado sem ANVIL_SCOPE_CORPUS; corpus real de 24/10: 81,3% dos
   problemas que nasciam em apply/Verify pegos antes do build, 0 falso positivo em 30 jobs aceitos).
   Na lane odc (L3c, 24/10/2026, `PreflightRules/OdcScopeRules.cs`): ODC_SERVER_ACTION_PUBLIC, ODC_SESSION_VARIABLE, ODC_LOCALIZED_IMAGE,
   ODC_TRADITIONAL_WIDGET (patch para o widget equivalente), ODC_DELETE_RULE_FORCED e ODC_SETTING_SIZE no texto de dados (patch); IF_CLASS_MOVED
   vale tambem no ODC; `navigate RedirectToURL(...)` e destino do System. ACTION_KIND_NODE so na lane o11 (os mapas criar-*.json sao do
   Service Studio 11). Medicao: `ScopeOdcCorpusTests` (desligado sem ANVIL_SCOPE_CORPUS): 168 recusas reais do lab ODC e 30 aceitas, 0 recusa nova.
   O cliente agora faz auto-arranque do worker (desligue com `ANVIL_WORKER=0`). Pedidos concorrentes aguardam na fila;
   `ping` responde enquanto corre um comando e mostra `busy/currentCommand/runningMs/queued/commands`.
   `queuedMs` mede a espera. A cada 5000 comandos (configuravel por `ANVIL_WORKER_MAX_COMMANDS`) ou heap >2 GB em
   dois comandos, o worker drena e o proximo pedido arranca outro PID. Logs: `worker-<porta>-<pid>.log` na faixa.
   Cache de bases (BaseModelCache, ligado em todo worker das duas faixas; processo frio e `dotnet test` nao o usam): com a
   fila vazia, o worker carrega e percorre uma instancia NOVA das ultimas bases usadas; o proximo apply da mesma base
   (mesmo caminho, tamanho, data, sha256 dos bytes recalculado a cada pedido, Studio, kernel e parametros de load) TOMA-a
   uma vez e liberta-a como sempre. Nenhum modelo usado por um job volta ao cache. O resultado traz `baseCache` (`hit`,
   `key`, `acquireMs`, `prefetch`, `evicted`) e `timings.baseAcquireMs`; num acerto `loadMs` fica perto de 0. Medido em
   rondas quentes: find num modulo O11 de cliente 2,3-2,5 s -> 0,9-1,2 s (O11); logic no fixture ODC 4,6 s -> 2,3-2,4 s (ODC). Um pedido que
   chega durante a preparacao espera se for apply da mesma base; qualquer outro cancela-a (e ela recomeca depois). Limites:
   2 bases (`ANVIL_BASE_CACHE_ENTRIES`), 1 GB estimado (`ANVIL_BASE_CACHE_MB`), 20 min sem uso; as reservas saem antes
   das regras de memoria (heap vivo 1,5 GB, working set 2 GB). `ping` mostra `baseCache` (chaves sha16, hits, misses,
   prefetches, cancels, evictions, bytes) e `loadedModules` ja desconta as reservas (`cachedModules`); a piscina manda
   o apply ao worker livre que tem a base. Bases `job:` construidas na corrida nao entram. `ANVIL_BASE_CACHE=off` no
   ambiente do worker e so interruptor de emergencia do operador, nao opcao de uso. Prova: `scripts/base_cache_check.py`.
   Perda de ligacao depois do envio tem resultado desconhecido: confira o resultado antes de repetir uma escrita.
4. **Suite**: ao mudar o Anvil (C#/bridge/worker/compiladores), `dotnet test tests/Anvil.Tests` deve ficar verde antes do commit.
   Para entrega de app que altera somente job/spec, check-job + Verify/delta da entrega validam o proprio trabalho; a suite
   completa fica para CI/manutencao. Jobs de outras sessoes em desenvolvimento ficam fora dessa entrega.
5. **Entregar**: `anvil deliver --module <Modulo> --job tests/jobs/<job>.json --checks <Nome1,Nome2>`
   (CLI da faixa: `dotnet .local/cli/anvil.dll` no SS4; `.local/lane-ss5/cli/anvil.dll` no SS5).
   Studio aberto e logado: o comando ativa o modulo, regista um snapshot, aplica o job sobre ele, faz UM merge auto
   e valida o delta desde o snapshot e os nomes pedidos. Sem `--base` e sem `--publish`. Para varias partes, use `jobs`.
   Jobs so de prova nao entram: antes de registrar a tarefa ou chamar a bridge, o deliver recusa job em
   a pasta de prova K1 de `tests/jobs-live` (`NonDeliverableJobs`) ou com a marca `NEVER DELIVER` numa descricao (do job ou de elemento).
   `delivered=true` exige contrato satisfeito antes/depois do merge, nenhum erro novo e checks encontrados. Falhas dao
   exit 1, com stage/error e os artefatos em `<work>/deliver/<id>/result.json`; um merge ja aplicado fica para revisao,
   com Ctrl+Z normal do Studio. `unchanged=true` e sucesso sem mudanca; conflito/cancelamento nao sao sucesso.
   `snapshot_module` devolve `snapshot_id`/sha256. A bridge recusa base cujos bytes nao correspondam a um snapshot
   deste modulo registado nesta sessao e recusa foreign com outra chave de modulo, mesmo em chamadas manuais.
   `get_errors since=<snapshot_id>` devolve `new/fixed/preexisting/newErrors`. O estado completo continua disponivel.
   `python scripts/proof_merge.py --module ... --job ... --checks ...` e so um wrapper de `deliver`; `--publish` nesse
   script e apenas para provas em modulos de teste. No produto quem publica e o humano. Tickets-all: 3.131 ops,
   uma chamada de merge, 27,6 s no SS5, zero erros novos e um aviso declarado.
   Referencias de produtor (familia E, `Delivery/ReferenceClosure.cs`, `Adapters.SS11/ReferenceInventory.cs`): numa entrega de
   consumidor (ops `reference`, produtores capturados ou ligados) o kernel le as referencias do snapshot, do candidato e do
   modulo mesclado. R5: dono de tipo estrangeiro (`foreign-owner-of`) que a base ja referencia com todos os objetos usados nao
   entra no apply nem no `refresh_references`; a assinatura dele fica como esta (`referenceClosure.owners`). Antes do merge,
   produtor nomeado ausente, fora da assinatura publicada ou mudanca colateral de assinatura recusam uma vez com
   `REFERENCE_CLOSURE_REFUSED` (`problems[]` com produtor, chave, hashes e fix). Depois do merge, referencia que o modulo nao
   manteve (hash ou exportacao do candidato) deixa o merge para revisao com `REFERENCE_NOT_RETAINED`. `MERGE_ROLLED_BACK` traz
   `referenceSignatureChanges` (produtor, hash base -> candidato, se o job nomeou) e o estagio. Testes:
   `tests/Anvil.Tests/FamDepsReferenceTests.cs`; prova offline nos arquivos do incidente: `C:\t\fam-deps\logs\prova-offline-r5.txt`.
   Dialogos durante a entrega (familia D, `Kernel/OperationDialogs.cs`, bridge `StudioDialogSurface.cs`): nenhuma excecao do SSAM
   sai de um comando do Studio (`QuietCommand`: o SDK desfaz o comando com `RollbackCurrentCommand`, sem o "Unexpected Error").
   Janela que abre durante o merge e do merge: erro do Studio e dependencias fecham sozinhos e entram no recibo (`dialogs`);
   recuperacao, login, consentimento ou pergunta com escolhas voltam em segundos como `STUDIO_DIALOG_PENDING` com `question`
   e o texto exato; o merge espera a pessoa e `deliver --resume` fecha a tarefa. Prazo do socket por verbo = limite da bridge
   + margem (`Delivery/BridgeDeadlines.cs`). Testes: `FamDepsDialogTests.cs`, `FamDepsQuietCommandTests.cs`.
   Revisao (2026-10-13): erro do Studio fechado durante o merge nunca vale como entregue: o kernel prova o modulo contra a
   base no mesmo call (`STUDIO_ERROR_DURING_MERGE`, `studioError` com estagio, texto e prova); a fachada projeta `dialogs` em
   toda resposta. `CompareAndMerge` nao vai dentro de `QuietCommand` (o SDK o envolve em `Runtime.SafeExecute`; aninhado, uma
   falha engolida deixaria merge parcial). `MERGE_ROLLED_BACK` so diz "mesmo job" com `sameJobAgain` (o kernel rodou o
   `refresh_references` daqueles produtores e o modulo ficou na assinatura do candidato); senao, produtores como OML. R5 e
   decidido antes do refresh (`pre-refresh.oml`): dono ligado tambem e atualizado. Dialogo web sem texto e relido por ate 10 s
   antes de virar pergunta; presenter modal (Manage Dependencies, merge editor) entra na vigia; depois de `blocked` a vigia
   fica com o merge ate o fim e `merge_status` devolve `pendingDialog` (o resume repete a pergunta de agora); merge que a aba
   nao rodou no prazo e abandonado e libera o proximo (`OperationLease`). `refresh_references` tem a mesma vigia; merge,
   refresh e publish fecham sozinhos o "Unexpected Error" e o registram. Testes: `FamDepsReviewDialogTests.cs` e os novos de
   `FamDepsReferenceTests.cs`.
6. **Registrar**: uma linha em `docs/PROVAS.md` (data, prova, numeros, comando) e commit.

Definicao de pronto: job valido (Verify 0 erros, warnings so os esperados), checks apropriados ao escopo, merge com TrueChange 0 erros,
nomes encontrados no Studio, linha em PROVAS.md.

### Layout e nomes de decisoes

Motor compartilhado: `FlowGraphLayout` da revisao Anvil `d4d8ece` (13/09), integrado nesta raiz;
`layout` informa `engineRevision: anvil-d4d8ece`. Nao usar os checkouts preservados como dependencia.
`flow-layout-decisions.json`, `FlowGraphLayoutTests` e `NativeFlowPolicyTests` provam Ifs aninhados,
reencontros, branches opcionais na coluna principal, handlers laterais, retornos e loops.
O layout usa espacamento de 80 px, preserva nos de trabalho e a semantica True/False. Pode separar
um End de action compartilhado em copias terminais equivalentes (`separatedEnds`); nunca duplica
End de processo. O contrato aceita essas copias somente nas arestas terminais declaradas e continua
recusando nos orfaos, desabilitados ou reconvergencias de trabalho alteradas. If/while sem `as` exibem a condicao;
`label` permite um titulo explicito sem mudar o alias. O tradutor C# preserva o predicado original no label.
Ao aplicar `layout` em actions existentes, apenas labels genericos If/While numerados sao substituidos;
nomes significativos sao preservados. Para corrigir um modulo existente, entregue ops `layout` sobre
as actions selecionadas, por snapshot/merge normal. Atualizar o CLI nao reorganiza modulos automaticamente.
`ModelSession.Apply` aplica o mesmo motor no fim de jobs que criam/removem/religam nos ou mudam
coordenadas. Flows nao alterados e jobs somente de leitura sao preservados. `flowLayoutEngine` no
recibo identifica o motor usado; `automaticLayouts` lista os flows normalizados pela transacao.
Conector sem alvo (a condicao de um Switch copiado) ou cujo alvo nao e no de logica (comentario ligado ao End de um
processo ou a uma tela do fluxo de UI) nao e aresta do layout: antes derrubava o job fora de qualquer op
(`layout-unfollowed-connectors.json`, nas duas faixas). Origem, integracao e limites: `../docs/LAYOUT-MOTOR.md`. Nao afirmar que todos os conectores sao ortogonais:
rejoins compartilhados e retornos de loop podem continuar diagonais.

## 1. Quero criar... (tabela por tarefa)

Antes de abrir exemplos, use `anvil recipe --find <tarefa>`: devolve a linha desta tabela, o job testado,
descricao e contagem de ops. Para ver ops, `recipe --find <nome> --ops --max 20` limita o total de ops; uma op spec pode conter muitos elementos.
`anvil where-can --name <Interface>` compara os quatro fixtures e verifica o hash do catalogo. `no-parent`
significa pai nao alcancavel ate profundidade 4; Library ainda nao tem fixture nem prova. O comando recusa mapas antigos.
Para a linguagem compacta, `anvil api --op logic|spec|screen|html` expoe as mesmas listas fechadas usadas pelo compilador.
Aqui `anvil` significa `dotnet .local/cli/anvil.dll` no SS4 ou `dotnet .local/lane-ss5/cli/anvil.dll` no SS5.

| Task | When to use | Where it can | Copy from (tests/jobs) | Verify |
|---|---|---|---|---|
| Complete data model | Related entities, static with additional values, long text and indexes in one spec | Service | `hire-data-model.json` (65 entities, 46 static, 73 indexes) | dataProof after merge and check-delivery with current hashes |
| Entity (table) | Data persisted on the server. Id Long Integer AutoNumber and IdentifierAttribute are mandatory; FK = `<Entity> Identifier`; `set $ent Public true` (+ `ExposeReadOnly true`) so other modules can read it; the same `set ... Public true` applies to structures, actions and roles | Service, Reactive, Mobile, Traditional (not Library) | `spec-data.json` (1 `spec` op) or `smoke-data-logic.json` (verb by verb) | `find` of the entity; Verify without `InvalidEntity_*` |
| Static entity | Fixed list of values (status, type) used as an FK and in `Entities.X.Y` expressions | Same as entity | `spec-data.json` (records) or `static-entity.json`; maintaining an inherited static (new record, `set Identifier` to rename a record, `rename` of the entity, usages): `static-entity-lifecycle.json`; refactoring (replace between records, delete of a record without consumers, duplicate of the entity): `static-record-refactor.json`; deleting the static entity itself without author consumers passes without force (`delete-generated-companions.json`: the anonymous `<Entity> Record` only counts if someone uses it) | records visible in `dump`; refusals proven in `tests/jobs-negative` (`rename-static-record.json`, `set-identifier-clash.json`, `delete-static-record-in-use.json`, `move-static-record.json`) |
| Structure | Composite type for inputs/outputs, REST, in-memory lists; Public if it leaves the module | All | `producer-public.json`, `spec-data.json`; maintaining an inherited structure (new attribute, DataType, rename of an attribute with a consuming expression, rename of the structure): `structure-lifecycle.json`; refactoring (move of an attribute, duplicate of the structure, replace between structures = repointing proven, delete of the source without force after the replace; the source's anonymous record survives as an orphan, cleanup not proven): `structure-refactor.json` | used as `DataType` without error; refusals in `tests/jobs-negative` (`delete-structure-attribute-in-use.json`, `delete-structure-in-use.json`, `rename-structure-clash.json`) |
| Client entity (local storage) | Offline data on the device. Id Long Integer WITHOUT AutoNumber (Verify refuses `IsAutoNumber Yes` on a client entity); save with `IExecuteClientActionNode` + `IEntityActionSignature:CreateOrUpdateX` in a client action | Mobile only | `local-storage-mobile.json`, `local-storage-notes-mobile.json` (with Accordion and reload) | screen aggregate with `args.isClientSide: true` |
| Site property | Server configuration editable in Service Center | Service, Reactive, Mobile, Traditional | `security-config-reactive.json` | `get` shows DefaultValue |
| Client variable | State on the client that survives navigation (current filter, preferences) | Reactive, Mobile | `security-config-reactive.json`; debugger variable types: `debugger-client-variable-all-types.json` (the twelve accepted types) and `debugger-client-variable-compound-type.json` (Binary Data, Record and List: Verify error `UnallowedTypeForClientVariable`); Object is already refused at `set DataType` (`tests/jobs-negative/debugger-client-variable-object-type.json`); ODC: `tests/jobs-odc/debugger-client-variable-all-types.json`, `tests/jobs-odc/debugger-client-variable-compound-type.json` and `tests/jobs-odc-negative/debugger-client-variable-object-type.json` | used in an expression without error |
| Session variable | Session state on the server | Traditional only (`ISessionVariable` in the `@espace`) | debugger variable types: `debugger-session-variable-all-types.json` and `debugger-session-variable-compound-type.json` (session only in Traditional Web; Binary Data and List accepted, with the suggestions `BinaryDataSessionVariable` and `RecordListSessionVariable`) | Verify |
| Role | Restrict a screen or action to a profile | Reactive, Mobile, Traditional, Service | `security-config-reactive.json` (`link` in `Roles` of the screen) | `get` of the screen: `Roles` > 0 (in `get`, expression properties appear as `@chave.#Prop`; use `dump` to see the text) |
| Server action | Server logic: query, save, calculate, call REST. The screen calls a wrapper, not the entity action (Security Warning) | Service, Reactive, Mobile, Traditional | `smoke-data-logic.json` (aggregate, If, Assign, Execute, Raise), `producer-public.json`, `aggregate-full.json` (join, sort, group) | `layout` without overlap; `find` of the action |
| Default entity actions (GENERATED: never write by hand) | List, read, save and delete each entity of the module, with service actions: one `entity-actions` op reads the module's own data model and writes, per entity, Get<E>List (joins, filters, search, order, pagination), Get<E>ById, Save<E> (validations, owner, typed errors) and Remove<E> (owner, references), as logic texts (section 2.1a) | Service, Reactive, Mobile (O11 and ODC) | `entity-actions.json` (the model with all the shapes, the op and a business action that calls the generated ones) | the same op again answers NO_CHANGE; `kept` lists the same-name actions that stayed |
| Action by logic SPEC (preferred for business server/service actions) | One `logic` op declares inputs/outputs/vars and the steps (get, assign, call, save/create/update/delete, if/then/else, foreach, raise); Start, End, links and layout are generated; CLOSED schema: a wrong key, a nonexistent entity/action/exception or a repeated name fail at compilation with the list of what is allowed (section 2.1) | Service, Reactive, Mobile, Traditional | `logic-spec-services.json` (5 actions: 4 service with call+assign, 1 server with all the shapes); negative `logic-unknown-key.json`; `cat-a-reset-typed-values.json` (new action that resets typed outputs to the neutral values with two exclusions, call inserted in a branch of an inherited If: the new node is linked to the successor first and only then is the branch connector repointed); negative `cat-a-link-unknown-connector.json` (a connector the node does not have) | `find` of the action; nodes with the names from `as` |
| Service action | Expose logic of a Service module to other modules by remote call, without a strong reference to entities | Service only (the map refuses in UI) | `service-action.json`, `service-action-update.json` (reads, changes and saves) | the consumer calls it with `IExecuteServerActionNode` |
| Client action | Logic in the browser/device: JavaScript, local storage, formatting without a server. Call from a screen action: `create IExecuteClientActionNode` + `set Action IClientAction:X` + `$no/<Input>` | Reactive, Mobile | `client-js-reactive.json`, `client-js-format-reactive.json`, `local-storage-mobile.json` | if JS, `set JavaScript` with `$parameters` |
| Screen action | Reaction to a screen event (button, link, block event); calls server and client actions | Reactive, Mobile and Traditional screens | `screen-form-reactive.json`, `osui-patterns.json` (event handler), `cat-b-screen-lifecycle.json` (lifecycle: OnInitialize/OnReady/OnDestroy of the screen and OnParametersChanged of the block linked to screen actions; the same scenario in `tests/jobs-odc`) | `set $btn/OnClick Destination` without `RequiredPropertyValue` |
| Data action | Screen data coming from logic (REST, calculation, assembled list) instead of an aggregate | Reactive/Mobile screens and blocks | `data-action-reactive.json` | output used on the screen (`GetX.Saida`) |
| Aggregate | Read entities with filter (`IFilter` args.condition, may cite inputs), join (`IJoin` LeftSource/RightSource/JoinType/Condition), sort (`ISort`), group by (`IGroupByAttribute`), aggregations (`IAggregateAttribute` + `AggregationType` Count/Sum/Max/Min/Avg; in ODC the interface is called `IAggregatedAttribute`, and the compact `get` of the logic spec picks the lane's name: `tests/jobs-odc/logic-aggregate-columns.json`), calculated column (`ICalculatedAttribute` + `set Value <expressao>`), `set MaxRecords` | Actions (`IAggregateNode`), screens (`IScreenAggregate`), preparations | `aggregate-full.json` (join + Count), `aggregate-sum-calc.json` (Sum/Max/Min/Avg + calculated), `screen-form-reactive.json` | without group by: `GetX.List.Current.Entidade.Attr`; WITH group by or aggregation: `GetX.List.Current.<NomeDaColuna>` (without the entity alias); `GetX.List.Length` |
| SQL | Query the aggregate cannot express: `ISQLNode` + `set Statement` (`{Entidade}.[Attr]`, `@Param`), `ISQLInputParameter` with `DataType`, `ISQLOutput` with `args.entityOrStructure` (entity or structure), argument `set $sql/arg:Param Value`, result in `<No>.List` (`<Structure> List`) | Server actions | `sql-input-output.json`; recipe `src/Anvil.Core/Recipes/TemporadaRecipe.cs` (Home_Search) | output used in an Assign; `SQL_Enumeration` is only a suggestion (use `{X}.*` if you want 0 warnings) |
| Timer | Task scheduled or triggered by an action. The schedule is the `Schedule` (e.g. `"10:00 14:30"`) or the timer's `CronSchedule`; an `ITimeOfDay` keeps `Interval` Any (the time is its Hour/Minute; `AtOrOn` is refused because the platform crashes when sorting two items: `tests/jobs-odc-negative/timeofday-interval-atoron.json`) . O11: `Schedule` as text, `"Every 60 minutes"`, `"Every day at 00:00"`, `"Every Monday at 00:05"` | Service, Reactive, Mobile, Traditional | `pacote-laneE-timer-schedule.json` (O11, the three schedules), `process-human-traditional.json`; ODC: `tests/jobs-odc/timer-time-of-day.json` | `Action` set; `get` reads the `Schedule` |
| Image | Module image (logo, icon) and, only in Traditional, the per-language version (`ILocalizedImage`, refused by the platform in Reactive, Mobile and ODC) | Reactive, Mobile, Traditional (not Service) | `image-localized.json` (`args.binary` in base64, `create ILocale` with `args.culture`); ODC: `tests/jobs-odc/image-create.json`; negatives `image-binary-not-base64.json` and `tests/jobs-odc-negative/localized-image-reactive.json` | `get`: Width, Height and OriginalFormat read from the binary |
| Process (BPT) | Flow with automatic and human steps, durability and taskbox. Human Activity: `set $human Destination IWebScreen:Tela` and then the screen's inputs become arguments `$human/<Input>`. Editing: the automatic activity is ALREADY BORN with its own Start and End (creating your own gives `InvalidFlow_TooManyNodes`), and `link` between process nodes ADDS a connector instead of replacing, so inserting a step in the middle requires deleting the existing connector first. Deleting an activity requires deleting the connector that consumes it first (`usages` shows it as the previous node's connector) | Service, Reactive, Traditional; Human Activity only with a Traditional screen as destination | `process-bpt.json`, `process-human-traditional.json`, `process-expense-traditional.json`, `process-edit-delete.json` (edit and delete) | `Detail` set; `layout` of the process |
| Consumed REST | Call an external API. The query string goes in the `URLPath` itself (`/latest?from={from}&to={to}`) with one `UrlPlacement` input per `{param}`; nested structures: create the child first and use its name as the attribute's `DataType`; Text literals in arguments take quotes (`"\"EUR\""`) | Service, Reactive, Mobile, Traditional | `rest-consume-get.json`, `rest-consume-post.json` (auth, headers), `rest-consume-call.json`, `rest-query-nested.json` (query string, nested structure) | Verify; then publish and call |
| Exposed REST | Expose endpoint | Same | `rest-expose.json` | `IRestServiceAction` is already born with Start/End |
| REST in one op (consume, expose, OpenAPI) | Whole client or service in one call: `rest` op (client, methods, structures, openapi, remove, breaks) and `rest-expose` op (service, methods with action/arguments/results or steps, remove); section 2.2 | All | `rest-spec-consume.json`, `rest-spec-expose.json`, `rest-spec-edit-delete.json` (redeclare in place and remove); ODC: `tests/jobs-odc/rest-spec-consume.json`, `rest-openapi-import.json`; negatives `rest-spec-invalid-path.json`, `rest-delete-consumers.json` | `integration` result (imported/updated/removed) |
| SOAP (O11) | Consume a SOAP web service from the WSDL: `soap` op (wsdl, port, methods, refresh, remove) through `o11_deliver` (the Studio's own import via the bridge, then a merge); ODC: `SOAP_LANE_UNSUPPORTED` | O11 | negative `soap-method-not-found.json`; live `tests/jobs-live/soap-import-calculator.json` | `integration.selection` result (port); exact WSDL types |
| Email | Transactional email | Traditional only (flow `Emails`) | `email-traditional.json`, `email-digest-foreach-traditional.json` (ForEach + timer) | `ISendEmailNode` with `Email` and `To` |
| Reference to another module | Use a public entity, action or block of another module: `{"op":"reference","producer":"job:producer-public" or "Headless_CS","elements":["IServerEntity:Product","IServerAction:Product_GetById"]}`; `job:` looks in the job's folder and in tests/jobs; named snapshot bound by `--producer Headless_CS=<oml>`; direct paths only for fixtures; the structures that the elements use come along. Producer without a local OML (.NET extension, eSpace or (System)): `anvil signature --producer <Name> --elements "<Type:Name>" --out <abs>.avsig` captures the server signature read-only through the logged-in Studio (VersionId guard, type closure) and the job binds `--producer <Name>=<.avsig>` (`System=<.avsig>` for the (System)), with the `.avsig` refs as the first ops; `elements: []` refreshes an existing reference; in deliver, `--capture-producer Name[=Producer]` captures into the task folder (once per producer; the resume captures only the missing ones) and re-attests before the apply and the merge (`docs/proofs/2026-09-26-o11-manage-dependencies.md`) | All | `consume-reference.json`, `consume-reference-screens.json` (screen with Table and detail); live `tests/jobs-live/consume-headless-cs.json` | `find` of the element; TrueChange without `OutdatedReference` |
| End-user roles (O11) | Grant/revoke persistent roles of the module ITSELF to existing accounts (demo = username in the owner module's defaults `DemoLoginUsernames`/`OpsDemoLoginUsernames`, read from the OML; the manifest flag only confirms; the generated `ReconcileAccess` re-checks `Site.<allowlist>` at run time before creating an account or granting the demo row), through a versioned manifest; never a password, UserManager or Users roles | Module that owns the role ((System) User reference) | manifests in `tests/access/` (they are not jobs): `anvil access plan --manifest <m>` (or `ssam access plan --lane o11`) reads the roles from the current OMLs, generates and proves a private job per owner module; `access apply --words "..."` only prepares (`deliver` commands with `--expected-environment` and a receipt with hashes only); executing is `--execute` in the CLI only (the `o11_access` MCP never executes), with the same `--port`/`--deliver-work` as the preparation (otherwise it refuses); contract and proof in `docs/proofs/2026-09-26-o11-access.md` | plan receipt ok, 0 new messages, `publicActions 0`; after publishing the user checks in the Users app |
| Default entity screens | List (table with pagination, search, filters, sorting and states), detail and form for each entity, generated from the module's model, its actions and its blocks: `{"op":"screen","data":{"generate":{"entities":["Customer","Order"]}}}` (section 3.4.1) | Reactive/Mobile (library: `patterns:true`, blocks only) | `screen-generate-reactive.json`, `screen-generate-actions-reactive.json` (read and write through the module's actions found by signature); ODC `jobs-odc/screen-generate.json` | 0 new messages; fixed point C1 of the generated roots; the same request again is `NO_CHANGE` |
| Screen spec | Catalog, table, detail, form or dashboard using the module's blocks (section 3.4) | Reactive/Mobile | `screen-spec-cards-reactive.json`, `screen-spec-cards-mobile.json`, `screen-spec-table-reactive.json`, `screen-spec-detail-tabs-reactive.json`, `screen-spec-form-reactive.json`, `screen-spec-dashboard-reactive.json`, `screen-spec-store-reactive.json` | 0 new messages; find of CardSectioned, Pagination, Search, Tabs, Rating |
| HTML/CSS authoring | A whole page written in HTML/CSS by the LLM with a manifest typed by `data-av` key (section 3.5): tags, order, classes and attributes preserved; data, filters, dates, events, derived values and JS functions only through the manifest; scoped CSS installed in the theme; existing screen updated with identity preserved | Reactive/Mobile | `html-dashboard-reactive.json`, `html-dashboard-update.json` (delta), `tests/jobs-live/html-dashboard-incidents.json` (product); source `tests/html/incidents-dashboard.html` via `scripts/gen_html_job.py` | 0 new messages; find of Dashboard, LoadDashboard, Page, Recent, PeriodStart |
| Reactive/Mobile screen | Section 3.1 | Reactive, Mobile | `screen-reactive.json` (minimal: layout, aggregate, List), `screen-form-reactive.json`, `screen-list-reactive.json`, `screen-search-refresh-reactive.json` (search with `like`, Table, Refresh Data), `table-if-reactive.json`, `widgets-reactive.json`, `gallery-native-reactive.json`; O11 ports of the proven ODC front B jobs: `cat-b-app-events.json` (external site and application events), `cat-b-block-placeholder.json` (block placeholder with sample content and instances), `cat-b-flow-comment-popover.json` (UI flow comment and popover/metadata), `cat-b-theme-resource.json` (theme, script and resource: birth, edit, refactoring and deletion) | `dump` of the screen; TrueChange |
| Traditional screen | Section 3.2 | Traditional | `screen-crud-traditional.json`, `osui-web-patterns.json`, `cat-b-traditional-gallery.json` (web widgets that no job created, from the screen-coverage contracts) | same |
| OutSystems UI pattern | Accordion, Tabs, Card, DatePicker, Carousel... (section 3.3) | Reactive/Mobile: OutSystemsUI; Traditional: OutSystemsUIWeb | `osui-patterns.json`, `osui-datepicker-handler.json` (DatePicker, Tag, Tooltip, Counter), `osui-patterns-mobile.json`, `osui-web-patterns.json`; contract in `docs/ui/<Modulo>/blocks/<Bloco>.md` | `docs/ui/gallery-reactive.md` says whether the block is born clean |
| Whole request in one job (single batch) | All the changes of a request for one module in a single job and a single call (split only by module): user exception and site property (raw verbs), entity and structure (`spec`) and four public server actions that call each other in a `logic` op (get with filters, 2-key sort and max, if/raise, foreach with ListAppend, call, create, date functions, GetUserId into a variable before the aggregate). It is the example of the `ssam_discover` package for requests with several actions | Service | `single-job-actions.json` | 7 ops, Verify 0 messages |
| Whole app (reference) | Data model of 20 entities + 40 server actions + timers + service actions of a help desk, generated by script (`scripts/gen_tickets.py`) in 8 chained jobs (to prove in parts) plus the composite job `tickets-all.json` (`jobs`: the 8 parts in one transaction; it is the one that delivers everything in a single merge) | Service | `tickets-all.json`, `tickets-01-data.json`, `tickets-02-helpers.json`, `tickets-03-lifecycle.json`, `tickets-04-collab.json`, `tickets-05-org.json`, `tickets-06-sla.json`, `tickets-07-read.json`, `tickets-08-services.json` | each part with Verify 0 errors; specs in docs/specs/tickets-*.md |
| Refactor | Find out who uses it, rename, repoint, delete without breaking. `usages` returns `count` (all referrers), `real` (real use) and `entries` with `derived` true for what the Studio maintains on its own (aggregate attribute list, sample records and, in ODC, the `IRecordAttributeValue` of the sample record; also what the platform generates with the target and fixes when it is deleted, section 2 **Delete with consumers**); `rename` returns `consumers` and `expressionsRewritten`; `replace` (section 2) repoints all the consumers of one object to another; `duplicate` copies within the same parent with the platform's suffix and WITHOUT consumers; `move` reorders within the same parent and returns the resulting order; `delete` returns `brokenConsumers`; to rewrite an action use `logic` with `replace:true`, which recreates it in the same command and checks the consumers | All | `refactor-usages.json`, `refactor-contact-reactive.json`, `refactor-replace-action.json`, `rename-data-propagation.json`, `rename-logic-propagation.json`, `rename-interface-propagation.json`, `rename-indexed-attribute.json`, `refactor-duplicate.json`, `refactor-move.json`, `delete-data-consumers.json`, `delete-logic-consumers.json`, `delete-interface-consumers.json`, `cat-b-screen-replace-delete.json` (screen: `replace` of the consumers, `move`, `delete` without force; deleted button, reordered expression, renamed UI flow; the same scenario in `tests/jobs-odc`) | `usages` before and after; Verify 0 errors |
| Block event | The block talks to whoever instantiates it: `IBlockEvent` in the block (one `IInputParameter` per parameter, `IsMandatory`), `ITriggerNode` in a screen action of the block to fire it (`set $trg Event $ev`, arguments in `$trg/<Param>`), and on the screen `set $b/<Evento> Handler $acao` plus `set $b/<Evento>/<Param> Value`. The argument is an EXPRESSION, in a SUMMED scope: it sees the event's parameters AND the screen's variables, so the handler can have names outside the contract. Types: list and record pass (a list of a structure is read `Var.Current.<Attr>`, WITHOUT the aggregate level). Changing the contract afterwards breaks **whoever fires**, not whoever consumes (`ArgumentRequiredExpression` on the ITriggerNode). Two instances of the same block have independent handlers and the block still has ONE trigger. The consumer does not need to be a screen: a block instantiates another and the handler of the lower event fires the upper one. `IsMandatory` without a handler is NOT a kernel refusal or a warning: it is a Verify **error** (`EventHandlerRequiredAction`), charged per INSTANCE. The `IEventHandler` is born with the instance even when empty, so it counts in `usages` and the event `delete` is refused even with no handler wired; to delete, in this order: the IEventHandler, relink the predecessor and remove the ITriggerNode, the IBlockEvent, and finally the screen action that was left orphaned (otherwise `UnusedAction`) | Reactive and Mobile blocks | `block-events-reactive.json` (create and consume), `block-events-update.json` (change the contract, by `job:`), `block-events-types-reactive.json` (list, record, identifier and five more types), `block-events-two-instances-reactive.json` (two instances, summed scope), `block-events-nested-reactive.json` (block inside block), `block-events-mandatory-reactive.json` (mandatory without a handler: error), `block-events-delete-reactive.json` (delete in the right order), `cat-b-block-rename.json` (rename the event and the trigger node: the consumers follow by key) and `tests/jobs-negative/delete-block-event-in-use.json` (the refusal); in the ODC lane, `tests/jobs-odc/block-events` binds through visual authoring (which binds by NAME, without remapping), with `block-events-types`, `block-events-two-instances`, `block-events-nested`, `block-events-mandatory` and `tests/jobs-odc-negative/delete-block-event-in-use` | `usages` of the event: one ITriggerNode and one IEventHandler per instance; Verify 0 errors |

### Modelo de recrutamento e indices

`hire-business-actions.json` acrescenta o núcleo de actions Hire e dados de apoio; contratos e limites em `docs/specs/hire-business-actions.md`.

`hire-data-model.json` cria o modelo Hire: 65 entidades de negocio, 46 static entities, atributos, FKs,
auditoria e indices. Dicionario: `docs/specs/hire-data-model.md`; gerador: `scripts/gen_hire_data.py`.
Indices usam o verbo existente `create`, tipo nativo `EntityIndex` (ausente no Model API V1):
`{"op":"create","parent":"$Candidate","type":"EntityIndex","name":"IX_Name","args":{"unique":false,"attributes":["$Candidate.OrganizationId","$Candidate.FullName"]}}`.
A ordem de `attributes` e preservada; `unique:true` cria chave unica. Os atributos devem pertencer ao pai (server entity propria),
sem repeticoes; argumentos desconhecidos sao recusados. `get EntityIndex:Nome` mostra Unique e Attributes, inclusive apos reload.
O adapter SS11 usa os construtores publicos do Studio dentro da mesma transacao do job. Nao cria novo verbo.
Regras medidas no lote de dados (2026-09-23, as duas faixas; `docs/NAO-DA.md`, seccao "Lote de dados"): o nome tem no maximo 28
caracteres (o Studio trunca em silencio; no `create` o kernel escreve o nome truncado e relata em `nameTruncations`, no
`rename` recusa) e nao pode colidir na entidade; o mesmo indice de novo e no-op (`indexNoOps`); `rename EntityIndex:Nome` funciona nas
duas faixas (pela classe nativa); `set EntityIndex:Nome Unique true|false` funciona; `move` de indice e `duplicate` de indice sao
recusados (dois indices com a mesma composicao nao existem); a composicao muda-se apagando e recriando; no ODC `move
EntityIndex:X/<Attr> first|last|...` reordena os atributos do indice, no O11 nao (recusa). Toda FK nasce com `AutoIndex_<Attr>`, que
conta como consumidor: apagar a FK exige apagar o AutoIndex antes; `replace` de FK arrasta o AutoIndex antigo (apagar o AutoIndex
antigo depois do replace). O tipo identificador enderecа-se por `IServerEntity:E/#IIdentifierType` (so leitura, gerado pela
plataforma; as FKs de outras entidades apontam para ele, por isso `usages` da entidade sub-reporta as FKs; o `delete` da entidade
ve-as, porque olha os consumidores dos filhos: `tests/jobs-negative/delete-entity-fk-in-use.json`). `replace` entre entidades e recusado (renomear, ou reapontar atributo a atributo). `set DataType` numa FK com
DefaultValue e recusado ate `set DefaultValue ""`. Provas: `entity-lifecycle.json`, `entity-refactor.json`,
`data-contract-identity.json` (em `tests/jobs` e `tests/jobs-odc`) e os negativos `index-name-too-long`, `index-name-clash`,
`index-foreign-attribute`, `index-duplicate-composition`, `duplicate-index`, `move-index`, `move-index-attribute` (O11),
`delete-fk-attribute-autoindex`, `replace-entity`, `fk-type-change-with-default`, `delete-entity-in-use`.

## 2. Os verbos (docs/architecture/2026-09-04-modelo-de-verbos.md)

Escrita: `create` (parent, type, name?, args?, as?, source?, empty?), `set` (target, prop, value), `link` (from, connector?, to),
`reference` (producer, elements[]), `move`, `duplicate`, `delete` (target, force?), `layout` (target = action, preparation ou processo),
`rename` (target, name), `replace` (from, to, force?), `spec` (data). Leitura: `get`, `find` (name?, type?), `dump` (target, depth), `usages` (target).

Referencias a objetos: `$alias` (definido por `as`), `@espace`, `@<ObjectKey>`, `Tipo:Nome` (ex. `IServerEntity:Booking`,
`IMobileBlock:Tabs`; vale para elementos referenciados de outros modulos), `$pai/Filho` (filho por nome; argumento pelo nome do
parametro; placeholder pelo nome; handler de evento pelo nome do evento; propriedade que devolve objeto: `$btn/OnClick`,
`$tela/OnReady`, `$tbl/HeaderRow`), `$pai/#Tipo[n]` (n-esimo filho do tipo), `$pai/**Tipo[n]` (n-esimo descendente),
`$no/arg:Nome` e `$no/param:Nome` quando parametro e argumento tem o mesmo nome (no JavaScript).
Regras do motor (atritos 3): um alias responde com e sem `$`. `**Tipo[n]` segue a ordem do documento (pre-ordem, widgets na
ordem da tela). Os ramos de um If widget respondem a `True`/`False` e a `#IIfBranchWidget[n]`. Um `set <x>/<Evento>/<Arg>`
escrito antes do `Destination` do mesmo evento roda logo depois dele (`reorderedArguments`). Argumento que nao existe num
Execute ou evento lista os inputs do que ele chama. `delete` apaga junto os conteudos vazios de um placeholder
(`cascaded`) e espera o fim do job quando um op seguinte remove os consumidores (`pending`).
`set` cru: `Style` num widget sem Style vai para `StyleClasses` ou para a propriedade estendida `class`; numa
propriedade-expressao, palavras soltas viram texto entre aspas e `Tipo:Entidade/Atributo` vira `Entidade.Atributo`
(`expressionRewrites`); aspas desbalanceadas e propriedade que o elemento da base nao escreve sao recusadas antes do
primeiro op (`EXPRESSION_SYNTAX`, `PROPERTY_NOT_WRITABLE`). Campo com tipo JSON errado: `JSON_SHAPE` com ponteiro e patch;
job em array solto vale como `{"ops":[...]}`. Refresh Data de Data Action fica sem Max. Records. No ODC, nome de icone
FontAwesome vira o da tabela de conversao do Studio (`iconConversions`), nome desconhecido e `ICON_UNKNOWN`, e referencia
a `User` ou a entidade de outro app fica com Delete Rule `Ignore` (`Protect` explicito: `ODC_DELETE_RULE_FORCED`).
Variaveis locais: `create ILocalVariable` na action ou na tela + `set DataType`; guardar o output de um Execute = `IAssignNode`
com `IAssignment` (`Variable` = a variavel, `Value` = `<NomeDoNo>.<Output>`).
Dentro de expressoes: output de um no = `<NomeDoNo>.<Output>` (`GetUsers.List`, `MakeSlug.Slug`, `CreateOrUpdateX.Id`); argumento de um
Execute = `set $call/<Input> prop Value`; parametros da action pelo nome (`Title`); variavel local pelo nome; `Entities.X.Y` para static.

Tipos no `set DataType`: "Text", "Integer", "Long Integer", "Decimal", "Boolean", "Date", "Time", "Date Time", "Currency",
"Email", "Phone Number", "Binary Data", "Object", "<Entidade> Identifier", "<Entidade>" ou "<Structure>" (record, inclusive de
modulos referenciados), "<X> List" (cria a lista se preciso). Expressoes sao texto OutSystems: `set` de `Condition`, `Value`,
`Variable`, `Source`, `DefaultValue`, `ExceptionMessage`, e de qualquer propriedade que devolva expressao (Mandatory, Enabled...).
Valores no `set`: propriedade booleana ou numerica recebe JSON (`true`, `50`); propriedade-expressao recebe texto OutSystems entre
aspas do JSON (`"True"`, `"\"Ola\""`, `"GetX.List.Current.User.Name"`); `name` e opcional em widgets sem logica (Expression, Container).
Byte[] (o conteudo de uma imagem: `args.binary` de `create IImage`/`ILocalizedImage`) vai como texto base64 do ficheiro, nunca como
caminho. Um tipo cujo unico factory e `GetOrCreate<X>` usa-o no `create` (`ILocale` com `args.culture`, ex. `PT_PT`). Uma lista so de
leitura que o Model API edita por um par `Add...`/`Remove...` (ODC: `ISemanticSearchNode.SearchAttributes`) recebe no `set` um array
de referencias e fica exatamente com ele (`tests/jobs-odc/semantic-search-attributes.json`).
Colecoes que o Model API muda por metodos recebem a lista inteira tambem em `Roles` (Add/Remove da colecao); no Semantic Search
os itens podem ser o atributo (`$Entidade.Attr`) ou o seu `AsSearchable` (`tests/jobs-odc/logic-semantic-search.json`).
Funcoes de expressao: SO as do catalogo do Studio CARREGADO, e o catalogo DEPENDE DA FAIXA -- 121 no SS11
(`docs/functions.md`) e 128 no ODC Studio, que tem mais sete: `NullFile`, `Size`, `MIMEType`, `IsTemp`,
`IsOwnedByCurrentApp` (File), `GetAppName` (Organization) e `CheckEndUserRole` (Roles). Por isso `docs/functions.md`
NAO serve de lista fechada para um job ODC; o runner le o catalogo em runtime e ja aceita as 128 na faixa ODC.
Consulta (que responde pela faixa em que corre): `dotnet .local/cli/anvil.dll functions --find <parte do nome>` ou
`--name Substr`, que da a assinatura, os tipos, onde vale e exemplos.
Nomes de outras linguagens NAO existem (Right, Left, Mid, Len, ToText, ToString, Now, Today, IIf, DateDiff...): o runner devolve
`Hint UnknownFunction` com as parecidas (Right -> Substr/Length) antes do Verify; exemplo negativo em `tests/jobs-negative/unknown-function.json`.
Operadores: `and`, `or`, `not`, `=`, `<>`, `<`, `>`, `+`, `-`, `*`, `/`. As mais usadas: `Substr(t, inicio0, n)`, `Length(t)`, `Index(t, sub)`,
`Replace`, `Trim`, `ToUpper`, `IntegerToText`, `LongIntegerToText`, `DecimalToText`, `TextToInteger`, `DateTimeToText`, `FormatDateTime(dt, "yyyy-MM-dd")`,
`FormatDecimal`, `CurrDate()`, `CurrDateTime()`, `AddMinutes/AddHours/AddDays`, `DiffMinutes/DiffHours/DiffDays`, `NullIdentifier()`,
`NullDate()`, `NullTextIdentifier()`, `If(cond, a, b)`, `GetUserId()`, `CheckRole(RoleId, UserId)`.
Enums pelo nome: JoinType None/Inner/Right/Left/Full; Sort Ascending/Descending; AggregationType Count/Sum/Avg/Max/Min;
AutoNumber Yes/No; Method Submit/Ajax/Navigate. If: `link from $if connector TrueTarget|FalseTarget to $no`.

Gravar e ler registros dentro de uma action: `create IExecuteServerActionNode` + `set $no Action IEntityActionSignature:CreateOrUpdateX`
(ou UpdateX, CreateX, DeleteX, GetX) + `set $no/Source Value <record>` (Delete/Get: `$no/Id`); o output fica em `<NomeDoNo>.Id`.
Ler: `IAggregateNode` + `IAliasedSource` (args.dataSource) + `IFilter` (args.condition) e usar `GetX.List.Current.Entidade.Atributo`.
Nao de ao aggregate o nome padrao do Studio (`Get<Entidade>s`, ex. GetTeamMembers): ao receber filtro ele e renomeado sozinho
(GetTeamMembersByTeamId) e as expressoes que o citam quebram; use outro nome (GetMembersOfTeam).
Fluxos: `link from $a to $b` liga pelo conector padrao (`Target`); `connector` escolhe outro: If `TrueTarget|FalseTarget`, ForEach
`CycleTarget` (entra no ciclo; o `Target` e a saida), Switch pelos seus conectores; varios nos podem ligar ao mesmo `IEndNode`.
ForEach: `create IForEachNode` + `set Label` + `set RecordList "GetX.List"`, `link ... connector CycleTarget to $primeiroDoCiclo`,
`link $ultimoDoCiclo to $foreach` (volta) e `link $foreach to $depois` (saida); dentro do ciclo use `GetX.List.Current.X.Attr`.
Consulta rapida de qualquer interface do Model API (propriedades gravaveis, o que cria): `dotnet .local/cli/anvil.dll api --name IForEachNode`.
If: `link ... connector TrueTarget|FalseTarget`; em If, Assign e ForEach o `name`
do create e descartado, o que aparece e o `Label` (faca `set ... Label`).
Op `spec` (dados em 1 op): `{"op":"spec","data":{"static":[{"name":"X","records":[{"name":"A","label":"A","order":1}]}],
"entities":[{"name":"E","public":true,"description":"...","attributes":[{"name":"A","type":"Text","mandatory":true,"length":50,"default":"\"x\""}]}],
"clientEntities":[...],"structures":[{"name":"S","public":true,"attributes":[{"name":"A","type":"Text"}]}]}}`; `id`, `label` e `order` dos records
sao opcionais (default = posicao, nome e posicao; `id` inteiro positivo e unico na static); aliases gerados: `$E`, `$E.A`, `$X.A`, `$S`.
Atributo de structure aceita `length` e `label`. Valor de spec vira o literal que o Studio guarda (`true` = `True`, palavra solta
de Text entre aspas), relatado em `expressionRewrites`; texto de registro maior que o atributo e recusado com o fix exato
(`SPEC_VALUE_TOO_LONG`). Indice igual a um existente e no-op (`indexNoOps`). Nome de atributo ou indice com mais de 28
caracteres fica como o Studio guarda (os 28 primeiros, numerado se repetir) e a prova de dados espera esse nome (`nameTruncations`).
Structure que uma structure publica usa vira publica; autorreferencia com Delete Rule `Delete` fica `Protect` (relatados).
Convencoes que a API nao diz: Id Long Integer AutoNumber + IdentifierAttribute; static entity com Id Integer SEM AutoNumber
(SEMPRE: o ODC Studio recusa ao vivo 'StaticEntity Auto Number', que o Verify headless nao apanha; a spec poe `IsAutoNumber No`
e preenche o Id de cada registo com o `id` do registo ou a posicao 1..n; nos verbos crus o preflight recusa `IsAutoNumber Yes`
num atributo de static entity e exige `$registo/Id prop Value` em cada registo novo), Label, Order;
If/Assign/ForEach usam `Label`; `layout` sempre no fim de cada fluxo (nada na diagonal); server action wrapper em vez de entity
action direta a partir da tela; `delete` recusa se ha consumidores (use `usages`, ou `force`); `rename` recusa colisao de nome.

**Repontar consumidores (op `replace`).** `{"op":"replace","from":"<ref>","to":"<ref>"}` faz TODO consumidor de `from`
passar a apontar para `to`. Nao e busca e substituicao de texto: e o mesmo `AbstractObject.ReplaceReferences` que o
proprio Studio usa ao clonar e ao apagar, publico nas duas plataformas (no ODC ele ainda aparece na API como
`IObjectSignature.ReplaceReferences`). Quem reescreve por dentro sao as implementacoes da plataforma: expressoes
religam o binding, SQL e JavaScript regeneram o texto. O no consumidor mantem a MESMA chave. Tipos diferentes exigem
`force` (trocar por outro tipo quase sempre quebra o Verify). Literais, descricoes, URLs e CSS nunca propagam, como no
`rename`. Depois do replace o alvo antigo fica sem consumidores e o `delete` nao precisa de `force`. Provas:
`refactor-replace-action.json` (a tela passa a chamar a action nova e a antiga e apagada) e, na faixa ODC,
`tests/jobs-odc/refactor-replace-action.json`.

**Apagar com consumidores (op `delete`).** O `delete` recusa quando o alvo tem consumidores reais, e a mensagem
NOMEIA cada um pelo caminho (`delete: refused, <alvo> is used by N consumer(s): <caminho>; ... or pass "force": true
to break them`); usos derivados nao contam (lista de atributos do aggregate, registo de exemplo, e no ODC o
`IRecordAttributeValue`). As duas metades estao provadas. Caminho limpo: `delete-data-consumers.json` (atributo usado
por filtro de aggregate, Expression, argumento e Input, que saem um a um), `delete-logic-consumers.json` (action
chamada por outra action e por uma tela: `replace` reponta as duas e so entao o delete passa) e
`delete-interface-consumers.json` (Label com `TargetWidget` e bloco proprio instanciado). Recusa, em
`tests/jobs-negative/`: `delete-attribute-in-use.json`, `delete-action-in-use.json`, `delete-block-in-use.json` e
`delete-widget-in-use.json`. Na faixa ODC: `tests/jobs-odc/delete-data-consumers`, `delete-logic-consumers`,
`delete-data-in-use` e `delete-attribute-no-consumers` (este prova que o registo de exemplo nao bloqueia o delete).
Para apagar um no no meio de um fluxo, religue o predecessor ANTES: o conector de entrada conta como consumidor.
O delete olha os consumidores do alvo E dos seus filhos (a FK que cita o tipo identificador de uma entidade, o Execute
de uma action de entidade, a expressao que le um atributo); um consumidor dentro de outro (o IArgument de um Execute
que ja conta) nao se repete. Tambem nao contam, porque a plataforma os acerta sozinha ao apagar (o Studio apaga e o
modulo fica valido): o IDecisionOutcomeNode de cada conector de Decision (o fluxo da decisao e regenerado), a
propriedade `On*Callback` do cliente/servico REST que guarda o callback, o IArgument do no SQL para o parametro que ele
declara, e a DefaultScreen do modulo (fica o aviso 'Unknown Default Screen' no ESpace; escolha outra tela com
`set @espace DefaultScreen`). Os tipos gerados com o alvo -- o registo anonimo `<X> Record` e a lista `<X> List` de
uma entidade/structure, a excecao `Not <Role>` -- so contam se alguem os usa, e entao a recusa nomeia QUEM os usa (a
variavel, o handler). Provas: `delete-generated-companions.json`, `delete-platform-consumers.json`,
`delete-default-screen.json` (e os dois primeiros em `tests/jobs-odc`); recusas `delete-entity-list-type-in-use.json`,
`delete-role-exception-in-use.json`, `delete-entity-fk-in-use.json` (e os dois primeiros em `tests/jobs-odc-negative`).
O registo anonimo de um elemento apagado fica orfao no modelo em memoria e nao vai para o OML gravado.

**Renomear (op `rename`).** O `rename` recusa colisao de nome no mesmo escopo (`rename: 'X' clashes with an existing
name in that scope (the Studio would use 'X2'); pick another name`) e devolve `consumers` e `expressionsRewritten`.
Os consumidores ficam ligados por CHAVE e a plataforma regenera o texto do que e modelo: expressoes que citam
entidade, atributo, parametro ou variavel; o `Statement` do SQL (`{Entidade}.[Atributo]`); o corpo de um
`IJavaScriptNode` nos `$parameters.<Nome>`; o `URLPath` de um metodo REST exposto — INCLUSIVE o segmento com o nome
do metodo, ou seja, a URL publica do endpoint muda sozinha e ninguem avisa que os consumidores externos partiram; o
nome do no consumidor de uma action e o nome da instancia de um bloco (`ContactCard1` vira `PersonCard1` sozinho);
`Destination`, `SourceBlock`, argumentos e os `Label` automaticos. NAO acompanha nada disto, e e preciso corrigir a
mao: `Description`, `Label` escrito por `set`, literais de texto dentro de expressoes, nome de indice, nomes de
aggregate/widget/parametro que citem o nome antigo, o `StyleSheet` da tela e do bloco, a classe CSS na propriedade
`Style`, legendas de botao, o `window.<Global>` declarado dentro de um `IScript` e URLs escritas a mao.
**Diferenca de plataforma:** na faixa O11 uma expressao `<No>.<Saida>` NAO e reescrita quando a action, o no ou a
saida sao renomeados (o modulo cai com `ExpressionUnknownObject: Can't identify '<NomeAntigo>' element in
expression`); na faixa ODC a mesma expressao e reescrita sozinha. Nas duas faixas o `rename` devolve
`expressionsRewritten: 0` nesse caso, porque quem conta como consumidor e o NO, nao a expressao que le o no: quem
confiar no numero entrega quebrado. Depois de renomear uma action, LEIA de volta com `get`/`dump` as expressoes que
citam o no. Provas: `rename-data-propagation.json` (entidade, atributo, variavel, indice, SQL),
`rename-logic-propagation.json` (script, client/server/screen action, parametros de JavaScript, REST exposto),
`rename-interface-propagation.json` (tela, bloco, parametro de bloco, CSS e deep link) e a recusa em
`tests/jobs-negative/rename-name-clash.json`; na faixa ODC, `tests/jobs-odc/rename-data-propagation.json`,
`tests/jobs-odc/rename-logic-propagation.json`, `tests/jobs-odc/rename-interface-propagation.json` e
`tests/jobs-odc-negative/rename-name-clash.json`. Um `EntityIndex` segue o rename dos atributos que cobre (o `get`
mostra `Attributes` ja com o nome novo) e o contrato de dados afere isso por CHAVE, por isso renomear um atributo
indexado no MESMO job que cria o indice e entrega valida: `rename-indexed-attribute.json`.
O `rename` escreve o nome que o Studio mostra para o TIPO do alvo e devolve-o em `property`: `Name` na maioria;
`Identifier` num registo de static entity (com a mesma recusa de colisao e os consumidores reescritos); `Label` nos nos
If, Assign, ForEach, Switch e Message e na condicao de Switch (o rotulo repete-se, nao ha colisao); `Property` de um
Extended Property e `Event` de um Extended Event. O contrato de dados afere essa mesma propriedade. Recusa curta, sem
"Cannot find handler": conectores (`connectors have no name`), tipos sem nome nenhum (Start, End, Raise Exception,
Filter, Sort, Join, GroupBy, Assignment, Comment, itens de agenda: `has no name`), o que mostra o nome de outro objeto
(AddSource -> a fonte; destino -> a tela) e lugares fixos (system event, callbacks, Preparation: `has a fixed name`).
Provas: `rename-name-property.json` (nas duas faixas) e as recusas `rename-connector.json`, `rename-no-name.json` e
`rename-static-record.json` (colisao de Identifier) em `tests/jobs-negative` e `tests/jobs-odc-negative`.

**Duplicar (op `duplicate`).** E o Ctrl+D do Studio: a copia entra no MESMO pai, no FIM da sequencia, e o nome ganha o
sufixo que a PLATAFORMA escolhe (`Body` -> `Body2`, `Greet` -> `Greet2`) — o job nao escolhe o nome, renomeia a seguir
se quiser outro. Copiar um contentor, uma action, uma entidade ou uma tela leva tudo o que esta dentro, e as
referencias INTERNAS acompanham a copia (o botao copiado chama a action copiada), mas a copia nasce **sem
consumidores**: quem usava o original continua a usar o original. E por isso que a copia de uma action aparece no
Verify como `UnusedAction` — nao e defeito do job, e o significado da operacao; declare-a em `expectedMessages`.
A copia de uma entidade traz os proprios `IEntityActionSignature` (`GetDupNotice2`, ...) e o proprio identificador.
Provas: `refactor-duplicate.json` (atributo, entidade, widget, screen action e tela, com `usages` antes e depois a
mostrar `real: 1` no original e `real: 0` na copia) e, na faixa ODC, `tests/jobs-odc/refactor-duplicate.json`.
A copia e o copiar e colar nativo (ClipboardManager). `parent` cola noutro pai compativel (outra tela, outro UI flow,
outro bloco); quando o pai do Model API nao aceita o tipo, a colagem vai para o contentor nativo dentro dele que aceita
(o `content` de um IContainer, o Flows.Decision escondido debaixo de um IDecisionNode). O kernel recusa ANTES, com o
motivo, o que a colagem nativa recusaria so com 'Condition is false': o tipo que a plataforma nao copia sozinho
(CanBeRootOfImport falso: sort, join, fonte e operacao de agregado, conector, linha e celula de tabela, callbacks REST;
duplique o dono), a copia que leva uma model feature que este Studio nao carrega (ColumnGap usa ModernLayouts; no ODC
client entity, global events e expose SOAP tambem), o pai que nao aceita o tipo e o pai que ja tem o unico (Preparation,
OnException: passe `parent`). Provas: `tests/jobs/duplicate-into-parent-traditional.json`,
`tests/jobs/duplicate-into-parent-reactive.json`, `tests/jobs-odc/duplicate-into-parent.json`
e as recusas `tests/jobs-negative/duplicate-*.json` e `tests/jobs-odc-negative/duplicate-*.json`.

**Reordenar (op `move`).** Sem `into`, `move` REORDENA dentro do mesmo pai. Direcoes: `first`, `last`,
`before: <irmao>`, `after: <irmao>`; e `x`/`y` para posicionar um no de fluxo no desenho (so desenho). Devolve a
`order` que ficou, por isso a prova esta no proprio resultado do op e nao e preciso um `dump` a seguir. Funciona em
tudo o que o modelo guarda como sequencia: atributos de entidade (a ordem das colunas), widgets dentro de um
contentor (a ordem da pagina), parametros de entrada (a ordem que quem chama ve) e variaveis de tela. Duas recusas,
com a mensagem que ensina: `before`/`after` de um objeto de OUTRO pai (a plataforma cairia em `Condition is false`) e
um filho que o pai nao guarda em sequencia — as screen actions de uma tela, por exemplo, sao listadas pelo proprio
Studio e nao tem ordem de autor; a mensagem lista entao as sequencias que aquele pai tem. Nota: a API deixa por um
atributo a frente do proprio `Id`, coisa que a interface do Studio nao faz. Igual nas duas faixas. Provas:
`refactor-move.json` e `tests/jobs-negative/move-foreign-sibling.json`, `tests/jobs-negative/move-not-a-sequence.json`;
na faixa ODC, `tests/jobs-odc/refactor-move.json` e `tests/jobs-odc-negative/move-foreign-sibling.json`.

**Mudar de pai (op `move` com `into`).** `{op:"move", target, into, first?|last?|before?|after?}` usa os dois caminhos do
arrastar do Studio. Elemento de topo listado em pastas (action, entidade, structure, variavel de sitio/sessao/cliente,
timer, tema, script, recurso, role...): `into` e um `IFolder` do MESMO ramo da arvore, ou `@espace` para sair de
qualquer pasta; muda so `Folder`, a chave e os consumidores ficam iguais (`key.preserved: true`). Qualquer outro objeto
(widget, tela, bloco, variavel local, parametro, atributo): o move nativo (`IModelServices.MoveObject`) recria o objeto
no pai novo e religa cada consumidor; a CHAVE do objeto e dos descendentes com chave global e nova (`key.preserved:
false`, `keysChanged`), porque a plataforma da chave nova a raiz de toda importacao. Os aliases do job, o contrato de
dados e a prova de refatoracao seguem o objeto novo. `into` num contentor usa o contentor interno dele, como o `create`;
`first`/`last`/`before`/`after` posicionam no pai novo. Recusas, com a mensagem que ensina: pai que nao aceita o tipo
(o teste da propria plataforma), pasta de outro ramo, objeto publico (outros modulos o usam pela chave), consumidor que
fica fora de alcance no pai novo, e erro novo no Verify (o que o objeto usa deixou de estar ao alcance: um no ligado,
uma variavel da action antiga); o job inteiro nao entra. Igual nas duas faixas. Provas: `refactor-reparent.json`,
`tests/jobs-negative/move-into-incompatible.json`, `tests/jobs-negative/move-into-out-of-reach.json`,
`tests/jobs-negative/move-into-folder-branch.json`; na faixa ODC, `tests/jobs-odc/refactor-reparent.json` e os mesmos
tres nomes em `tests/jobs-odc-negative`.

**CSS do tema (op `set` de `StyleSheet`).** O CSS de um tema tem TRES metades no modelo e o Model API expoe so uma:
`GeneratedStyleSheet` (o que o Theme Editor gera), `UserStyleSheet` (o CSS do autor, que e o que o Studio mostra e
deixa editar) e `StyleSheet`, que e DERIVADA — `gerada + CRLF + autor`. Ler `StyleSheet` da a derivada; escrever
`StyleSheet` grava a metade do AUTOR. Ou seja: `set StyleSheet` num tema com CSS do Theme Editor SUBSTITUI o CSS do
autor, e o que volta no `get` seguinte e gerada + o seu texto, nao so o seu texto. Para ACRESCENTAR, leia antes
(`get` do tema mostra as tres metades quando elas divergem) e escreva o todo, ou use o op `html`, que ja faz o ciclo
e instala o bloco na metade do autor. O resultado do `set` diz onde o texto caiu (`styleSheet.wroteInto`,
`userChars`, `generatedChars`). Num tema SEM Theme Editor as tres metades sao o mesmo texto e nada disto aparece.
Vale nas duas faixas (o modelo e o mesmo); prova em `tests/jobs-odc/theme-css-halves.json` e nos numeros de
`Anvil.Tests.Odc.ThemeCssTests`.

**Codigo em varias linhas (CSS, SQL, JavaScript).** O texto de `StyleSheet` (tema, tela, bloco), `Statement` (no SQL,
inclusive o `statement` da op `logic`) e `JavaScript` (no JavaScript, script, tela, bloco), e o bloco que a op `html`
instala no tema, e formatado antes de chegar ao modelo, nas duas faixas (`src/Anvil.Core/Kernel/CodeFormat`). So muda
espacos fora de strings, comentarios e literais, e so quando o texto nao esta formatado: uma linha unica com mais de 80
caracteres e duas ou mais regras/clausulas/instrucoes, ou uma linha com mais de 120 caracteres que as tenha. CSS: uma
declaracao por linha, 4 espacos, `}` sozinha, linha em branco entre regras, @media indentado. SQL: SELECT, FROM, cada
JOIN, WHERE, GROUP BY, HAVING, ORDER BY e UNION na sua linha, colunas e AND/OR indentados, subconsulta indentada; a
caixa das palavras nao muda. JavaScript: quebra depois de `{` de bloco e de `;`, indentacao por nivel; codigo ja em
varias linhas fica como esta. Na escrita, um verificador independente prova que o texto formatado e o original sao o
mesmo codigo (no JavaScript, o mesmo programa lido pelo Esprima); se nao forem, vai o ORIGINAL e o recibo leva a nota
`FORMAT_SKIPPED` com o motivo. O recibo lista `formatted: [{element, language, linesBefore, linesAfter}]`. Provas:
`code-format-reactive.json` e `tests/jobs-odc/code-format.json` (`CodeFormatJobTests`, `CodeFormatOdcTests`,
`CodeFormatTests`).

### 2.1 Spec de logica (op `logic`)

```json
{"op":"logic","data":{"actions":[{
  "name":"Ticket_Cancel","kind":"server","public":true,"description":"...",
  "inputs":[{"name":"TicketId","type":"Ticket Identifier"},{"name":"Reason","type":"Text","mandatory":false}],
  "outputs":[{"name":"Ok","type":"Boolean"}],"vars":[{"name":"T","type":"Ticket"}],
  "steps":[
    {"get":"Ticket","as":"GetTicket","where":"Ticket.Id = TicketId","max":1},
    {"if":"GetTicket.List.Empty","then":[{"raise":"NotFound","message":"\"Ticket not found\""}]},
    {"assign":{"T":"GetTicket.List.Current.Ticket","T.StatusId":"Entities.TicketStatus.Cancelled"}},
    {"save":"Ticket","record":"T","as":"SaveTicket"},
    {"call":"Event_Write","as":"Ev","args":{"TicketId":"TicketId","Note":"Reason"}},
    {"foreach":"GetWatchers.List","as":"EachWatcher","do":[{"call":"Notification_Create","as":"Notify","args":{"UserId":"GetWatchers.List.Current.TicketWatcher.UserId"}}]},
    {"assign":{"Ok":"True"}}]}]}}
```

No `get` com `sql:true`, a op logic nomeia o output SQL `List`: um campo do record e
`<as>.List.Current.List.<Campo>` (diferente de aggregate e de uma lista de entidade comum). `Hint Current` consulta
ISQLNode.Type e mostra o wrapper real se a expressao estiver errada. SQL nao aceita where/sort/start fora do statement.

**ODC: app nao expoe server action publica.** Num modulo ODC que e app (Reactive Web/Mobile, nao biblioteca), `public: true`
numa server action (ou `set IServerAction:X Public true`) e recusado pelo verbo `set` antes do Verify: o Studio ao vivo da erro e o
Verify headless nao. Deixe Public No e chame a action das telas do proprio app; para servir outros apps use service action; para
reuso entre apps, biblioteca. Bibliotecas ODC e a faixa O11 nao mudam.

Buscas em lista na logica de cliente (screen/client action): `ListIndexOf`, `ListFilter`, `ListAny` e `ListAll` leem `Lista.Current`
pelo contexto de iteracao de quem chamou, e o codigo gerado ignora o elemento que o built-in passa. Dentro de For Each/While, num evento
de widget que esta dentro de uma List e numa screen action chamada por JavaScript (`$actions.X`), esse contexto prende o Current em um
elemento e a busca responde -1 ou a linha errada, sem erro (provado ao vivo na Escala Viva: cobertura 0/7, todo turno "Novo", barra
de selecao e arrastar inertes). O kernel recusa a busca dentro de laco; nos outros dois casos quem escreve decide. Escreva a busca como
For Each sobre a lista com um If que guarda a primeira posicao (`Pos` local iniciado em -1).

Chaves da action: `name`, `replace` (true para reescrever uma action propria existente preservando consumidores), `kind` (server | service | client), `public`, `function`, `description`, `inputs`, `outputs`, `vars`
(cada um `name`, `type`, `mandatory` so em inputs, `default`, `description`), `steps`. Um passo tem UMA forma:
`get` (aggregate sobre entidade propria ou referenciada; `as` obrigatorio, `where` texto ou lista, `sort` `"Ent.Attr"`,
`"Ent.Attr DESC"`, `"-Ent.Attr"`, lista delas ou `[{"by":"Ent.Attr","desc":true}]`, um ISort por chave, na ordem escrita,
`max`, `start`; le-se `<as>.List.Current.<Entidade>.<Attr>`, `<as>.List.Empty`, `<as>.List.Length`), `assign` (`{"Var": "expr"}`,
`as` opcional = Label), `call` (action propria, referenciada, de entidade `CreateOrUpdateX` ou de sistema `ListAppend`; sem `as`
o no leva o nome da action, numerado a partir do segundo como o Studio; outputs em `<as>.<Output>`), `save` | `create` | `update` (`record`) e `delete` (`id`) de entidade, `if` (`then`/`else`,
os ramos voltam ao fluxo; um ramo que acaba em `raise` nao volta), `foreach` (`do`), `raise` (exception do modulo; `message`).
Nome de no repetido nunca e recusado: o segundo vira `End2`, `S2` (como copia no Studio) e o preflight avisa (`LOGIC_NODE_RENAMED`).
A mesma screen action em telas diferentes sao duas actions (chave owner + nome). `'Long Text'` vira `Text` (`LOGIC_TYPE_MAPPED`).
O caminho do registro e o que a lista tem: `V.Current.T.X` de um input/var `T List` vira `V.Current.X`; `Q.List.Current.T.X`
de um SQL cujo output e `T` vira `Q.List.Current.List.X` (`LOGIC_CURRENT_REWRITTEN`). Todos os problemas da spec saem numa recusa
so (`LOGIC_INVALID`, um problema por passo com ponteiro relativo ao `data` do op), nunca um por rodada.
SQL na spec: `{"get":"SqlItem","sql":true,"as":"ReadSqlItems","statement":"SELECT {SqlItem}.* FROM {SqlItem} WHERE {SqlItem}.[Quantity] >= @Minimum","params":{"Minimum":{"type":"Integer","value":"Minimum"}},"max":50}`.
No `logic/get` com `sql:true`, o output criado chama-se `List`: o registro e `<as>.List.Current.List`, e um atributo e `<as>.List.Current.List.<Atributo>`. Confira o nome do `ISQLOutput` no dump; ele define esse nivel intermediario.
Exemplo completo: `logic-sql-params.json`. Os nomes @ usados e os declarados em params devem coincidir (sem distinguir maiusculas).
Comentarios e literais SQL nao contam; `@@ROWCOUNT` segue a leitura do Studio e exige parametro. `where`, `sort` e `start` sao
recusados com sql:true: filtre, ordene e pagine no statement. Assign `X = X` e recusado por nao fazer nada.
Nos verbos crus o Verify continua sendo o juiz (negativo `sql-unknown-param.json`). Erros de set/link listam os membros aceitos,
quatro nomes parecidos e o comando `anvil api --name <Tipo>`.
A linguagem ampliada tambem aceita `switch` com `otherwise`, `handlers` e `comments` na action, e `node/as/properties`
para a lista fechada de widgets exposta por `api --op logic`. JavaScript declara inputs/outputs/args no no. `kind: screen`
ou `preparation` exige um `owner` existente; consulte docs/CONTRATO-MODULO.md para tipos e limites. Nao traduza nomes do
menu em propriedades por adivinhacao. Excel exportado usa o proprio nome do no como Binary Data; importado, como lista.
Refresh Data nao aceita StartIndex nao vazio no contrato (o merge nativo o descarta); pagine na fonte. Entidade local
publica tambem e recusada no contrato; exponha structures publicas. A matriz compara os widgets do catalogo com provas.

Actions da mesma spec podem chamar umas as outras; o compilador ordena por dependencia e recusa ciclos com a cadeia.
`logic-call-order.json` prova essa ordem. Nome de action propria existente sem replace e erro (`logic-duplicate-action.json`),
inclusive em create. `replace:true` exige a action existente do mesmo kind; apaga e recria na mesma transacao e verifica que
as chaves dos consumidores do modulo, fora dos corpos substituidos, sobrevivem. Forneca a definicao completa (public, inputs, outputs e steps). `logic-spec-replace.json` prova a chamada e seus argumentos preservados.
Input ou variavel sem uso e output sem atribuicao nao recusam (A03): o Verify avisa, o aviso volta nao bloqueante, e o
preflight devolve a nota `LOGIC_UNUSED` com os nomes. Nomes dentro de strings, membros qualificados (`R.Campo`) e nomes da
entidade/alias no filtro nao contam como uso. Uso em `max`, `start`, qualquer chave de `sort` ou `params.*.value` conta.
Exemplo: `logic-unused-input.json` (agora aceito, com o aviso).
Gramatica tao larga quanto o Studio (atritos 3, C18): `label` vale em todo passo (vira o Label de Assign, If, For Each, Switch e
Message; nos outros nos, sem `as`, e o nome quando e identificador). `record` aceita os campos `{"Campo":"expr"}`: vira uma local
`<Entidade>Record`, um Assign e a action de entidade. `kind` do join aceita o nome da tela: `Only With`/`inner` = Inner,
`With or Without`/`left` = Left, `With`/`full` = Full. A mesma entidade duas vezes e self-join: a segunda fonte e `<Entidade>2`
(nota `LOGIC_SOURCE_RENAMED`). `DateFormat` omitido no JSON Serialize/Deserialize e `ISO`.
Expressoes sao texto OutSystems (secao 2; so funcoes de `docs/functions.md`). Mesma spec = mesmos ops, sempre. Os dados
(entidades, static, exceptions) vem antes por `spec` ou verbos: a `logic` resolve os nomes contra o modulo e recusa o que nao existe.

### 2.1a Actions padrao geradas (op `entity-actions`)

`{"op":"entity-actions","data":{"entities":"all","owner":{"attribute":"CreatedBy"},"expose":{"server":true,"service":true}}}`, primeiro no job;
as actions de negocio vem depois, como textos da op `logic`, e podem chamar as geradas. Contrato: `api --op entity-actions`.
O kernel le o modelo de dados do modulo (a leitura ssam-ddl/1: entidades, atributos, referencias e delete rules, indices,
atributo ativo e de label) e escreve, por server entity com identificador, textos ssam-flow/1 pela forma de texto da op
`logic` (cada action le de volta como o seu texto): Get<E>List (um aggregate com join as entidades que as referencias
nomeiam, filtros por referencia, texto e data indexados, busca no label e nos textos indexados, dono, ativo, ordem,
MaxRecords/StartIndex, a pagina como a structure <E>ListItem e o total), Get<E>ById, Save<E> (existencia, dono, obrigatorios,
tamanhos, referencias que precisam existir, chaves unicas, Create/Update ou CreateOrUpdate sem auto number; erros
ValidationFailed, NotFound e AccessDenied, criados se faltarem) e Remove<E> (existencia, dono, registros que ainda o
referenciam com Delete Rule Protect, ou o atributo ativo em False), mais uma service action por server action. Sem JavaScript,
sem For Each, sem aggregate em laco; tudo nomeado e descrito. Deterministico: o mesmo modelo e os mesmos dados dao os mesmos
textos. Nada existente e sobrescrito: action de mesmo nome que le como o texto gerado fica (unchanged; todas assim =
NO_CHANGE), qualquer outra fica e vem em `kept` com o texto gerado. ODC app: server actions privadas (as service actions sao
a entrada publica); entidade nao publica: actions privadas e sem service action (`notes`). Prova: `entity-actions.json` e a
bateria do corpus `tests/Shared/EntityActionsCorpusTests.cs`. Os nomes seguem a regra N1 do dono, verbo primeiro: Get<E>List,
Get<E>ById, Save<E>, Remove<E> e <Action>Service; `names {...}` so sobrescreve. Obrigatorios conferidos: textos, referencias
e datas; numeros, booleanos e horas nunca (0 e False tambem sao dado, sem regra unica que diga "faltando").

### 2.2 Integracoes (ops `rest`, `rest-consume`, `rest-expose`, `soap`; docs/integracoes-rest-soap.md)

Uma op por cliente ou servico; o contrato e `api --op rest|rest-consume|rest-expose|soap`. A op cria o que falta, atualiza no lugar pela chave
o que existe (quem chama continua ligado), nao toca o que nao nomeia e apaga o que `remove` lista. Todos os erros dos dados numa
recusa so, antes de qualquer op (`REST_*`, `REST_EXPOSE_*`, codigos de SOAP), pela regra `PreflightRules.IntegrationOps`.
- `rest`: `{"client":{"name","baseUrl","headers"},"methods":[{"name","http","path","inputs":[{"name","type","in":"url|query|header|body"}],"response":{"structure"|"sample"|"type"}}],"structures":[...],"remove":[...],"breaks":[...]}`. Expande so para os verbos crus provados; amostra JSON vira estruturas pelo plugin REST; credencial nunca no modelo (`REST_CREDENTIALS_NOT_IN_MODEL`, regra do SSAM no O11: entrada `Authorization` em header). `openapi {path, sha256, operations}`: ODC headless; O11 pelo `o11_deliver` (bridge).
- `rest-consume` (gerador, 13/10/2026; `RestConsume.cs` puro, `Verbs.RestConsume.cs` no modulo): `{"name":"<Cliente>","baseUrl"?,"methods":[{"name","url","verb"?,"sample"?,"request"?,"resource"?,"action"?,"params"?,"try"?,"timeout"?}],"expose"?,"errors"?}`. Uma op escreve a integracao inteira de qualquer API: o cliente e os metodos pela op `rest` (estruturas explicitas, `<Recurso>Json`, inferidas da amostra: Text, Integer, Long Integer, Decimal, Boolean, Date `yyyy-MM-dd`, Date Time ISO com `T` e segundos; numero escrito como texto fica Text; null/`[]` viram Text/Text List com aviso; lista de listas fica de fora com aviso; formas iguais sao uma estrutura so), uma estrutura publica por recurso (o espelho, mesmos nomes), o mapeamento escrito atributo a atributo (`Origem mapTo {A: A, R.A: R.A}`: a conversao automatica da plataforma deixa vazias algumas formas, "Empty Mapping", nas duas faixas; registro dois niveis abaixo e lista de registros passam por funcoes privadas `<Estrutura>[List]FromJson|ToJson`), e uma service action publica por metodo com nome Verbo+Cliente+Objeto (o verbo do proprio metodo quando o nome comeca por um, `ListRepos` vira `ListGitHubRepos`; senao o do HTTP: GET `Get`, POST `Send`, PUT `Save`, PATCH `Update`, DELETE `Delete`, `Feriados` vira `GetBrasilApiFeriados`; `action` sobrepoe; ODC library: server actions publicas; `expose.serviceActions:false`: server actions; `expose:false`: so o cliente) que chama o metodo e transforma qualquer falha na user exception `errors.exception` (padrao `<Cliente>Error`, reaproveitada se existe) com log. Action que muda dado (todo verbo menos GET) checa o usuario antes (`if GetUserId() = NullIdentifier()`, no ODC `NullTextIdentifier()`, raise `AccessDenied`, a do modulo ou criada) e chama a sua `<Action>_Impl` privada, onde ficam a chamada e o handler (`expose.guard:"none"` tira a checagem). Booleano leva Is/Has/Can (`fork` vira `IsFork`, o NameInJSON fica); todo elemento tem descricao, todo assign um label e o If uma pergunta: o OutSystems padroes (estagio oml) da 0 achados nas 15 amostras, nas duas faixas. Nada de For Each nem JavaScript. Cada elemento leva na descricao a marca `ssam:rest-consume <Cliente>/<Base> #<hash>`: a mesma op de novo nao muda nada (`changed:false`, tudo em `unchanged`); amostra mudada atualiza no lugar (mesmas chaves; o que sumiu e apagado depois que as actions foram reescritas); nome usado por outro elemento vai para o proximo livre (`renamed`). O kernel nunca le a rede: metodo GET sem `sample` e recusado com `REST_CONSUME_SAMPLE_MISSING`; a fachada (`integration-documents.mjs`) faz um GET por url (10 s, 2 MB, sem credencial, listas cortadas em 20) e fixa `sample` e `sampledFrom`. O recibo traz `generated` (cliente, base, excecao e, por metodo, o URL Path, os tipos e a assinatura da action). Exemplo provado: `rest-consume-generate.json` (O11) e `jobs-odc/rest-consume-generate.json`. Provas: `tests/Anvil.Tests/RestConsumeTests.cs`, `tests/Shared/RestConsumeScenarios.cs` (as duas faixas, amostras em `tests/fixtures/rest-consume`) e `platforms/odc/facade/tests/rest-consume-sampling.test.mjs` (url por um servidor local).
- `rest-consume` autenticada e customizada (`RestConsume.Auth.cs`, as duas faixas): `auth {type: bearer|basic|apiKey (in header|query, name)|oauth2 (tokenUrl https, scope, cacheMinutes)}`, `headers {Nome: literal}`, `methods[].headers {Nome: literal|{entrada}}`, `methods[].optional`, `correlationHeader`, `settings {baseUrl:true}`, `timeout`, `errors.status {"404": "<Excecao>"}`, `callbacks {before|after: {steps, vars}}`. Credencial nunca no modelo (`REST_CREDENTIALS_NOT_IN_MODEL`): o gerador cria as site properties (O11) / settings (ODC) vazias e secretas (`<Cliente>Token`, `<Cliente>ApiKey`, `<Cliente>ClientId`/`ClientSecret`; `basic`: no O11 `<Cliente>Username` e `<Cliente>Password`, codificados em tempo de execucao pela extensao BinaryData, `TextToBinaryData` + `BinaryToBase64`, cuja op `reference` a fachada acrescenta no fim do job e o `o11_deliver` captura, sem ela `REST_CONSUME_REFERENCE_MISSING`; no ODC `<Cliente>BasicCredentials` = Base64 de user:password; o correlation id vem de quem chama nas duas faixas, nenhum produtor de GUID offline), o `OnBeforeRequest` do cliente as le (oauth2: cliente `<Cliente>Auth` e `Get<Cliente>AccessToken` privada com Cache in Minutes) e o recibo traz `configure` (o que preencher e onde). O `OnAfterResponse` levanta a excecao do status mapeado ou `<Cliente>Error` com o status e 300 caracteres do corpo; os handlers das actions mantem a excecao mapeada. Os callbacks sao criados antes da op `logic` (que os substitui, mesmas chaves) e os tipos `HTTPHeader`/`URLQueryParameter` vao por `@chave` (cada cliente tem os seus; o ODC os nomeia `HTTPHeader5`). Callback que a op nao escreveu: `REST_CONSUME_CALLBACK_NOT_OWN`. Auth que muda apaga o que a op nao planeja mais. Op sem essas chaves escreve o mesmo de antes (modulos do commit anterior ficam `changed:false`). Leitura dos callbacks como texto: `ModelHost.RestCallbackTexts`. Exemplo provado: `rest-consume-auth.json` (O11) e `jobs-odc/rest-consume-auth.json`; provas `tests/Shared/RestConsumeAuthScenarios.cs` (O11 com a captura `tests/fixtures/rest-consume/producers/BinaryData.avsig`).
- `rest-expose`: cada metodo e uma action de logic de tipo `rest` (dono `IRestService:<S>`, `http`, `path`, parametro `in`); `action` + `arguments` + `results` geram chamada e atribuicao; ou `steps`. Start e End sao os do proprio metodo.
- `soap` (so O11): `{"wsdl","port"|"service"|"binding"|"soapVersion","methods","refresh","remove","breaks"}`. A selecao da porta e headless (`SoapPlan`); o import e o do Studio pela bridge (`integration_import`) dentro do `o11_deliver`; o candidato confere os tipos exatos (`SOAP_CONTRACT_TYPE_MISMATCH`). `ssam_job`/`o11_job` sem Studio: `INTEGRATION_IMPORT_NEEDS_STUDIO`.
- Documentos: a fachada fixa URL/caminho em `.local/documents/<sha256>/` e reescreve para `{path, sha256, source}`; o kernel nunca busca na rede (`DOCUMENT_NOT_PINNED`). Job de suite usa caminho relativo (`tests/fixtures/wsdl/...`).
- Apagar: `delete {target, breaks?}` recusa com `DELETE_HAS_CONSUMERS` (caminho de cada chamador); apague o chamador antes no mesmo job ou liste os caminhos exatos em `breaks` (diferente: `CONSUMERS_CHANGED`). Metodo SOAP apagado leva as estruturas sem uso. Na entrega, as palavras do dono nomeiam cada alvo e cada consumidor; concessao nunca cobre delete.

## 3. Telas

### 3.1 Reactive e Mobile (tests/jobs/screen-form-reactive.json, screen-list-reactive.json)

Tela: `create IMobileScreen` em `IMobileFlow:MainFlow`; o layout e o bloco padrao: `set $scr/#IMobileBlockInstanceWidget
SourceBlock IMobileBlock:LayoutTopMenu` (Mobile: `IMobileBlock:Layout`, placeholders `Title`, `Content`, `Navigation`, `HeaderLeft`, `HeaderRight`, `Bottom`). Uma `IList` aceita
widgets direto (Expression) ou um `IListItem`.
Input da tela: `IInputParameter` + `DataType`. Dados: `IScreenAggregate` com `IAliasedSource` (args.dataSource) e `IFilter`
(args.condition; texto: `User.Name like "%" + Search + "%"`). Entidade de outro modulo (User do Users): `IEntitySignature:User`; propria:
`IServerEntity:X`. Recarregar um aggregate numa screen action: `create IRefreshDataNode` + `set DataSource GetUsers`. Widgets nativos (plugin NRWidgets): IContainer, IExpression, IInput, ITextArea, ICheckbox, ISwitch,
IRadioGroup/IRadioButton, IDropdown, IButtonGroup/IButtonGroupItem, IUpload, IButton, ILink, IIcon, IImage, ILabel, IList/IListItem,
ITableRecords (IHeaderCell/IRowCell em `$tbl/HeaderRow` e `$tbl/Row`), IIfWidget (`$if/TrueBranch`), IPopup, IAdvancedHtml.
Regras: Input `set Variable` = `GetX.List.Current.Entidade.Atributo` ou variavel local; Button e Link ja nascem com texto
(`set $btn/#ITextWidget prop Text`; para texto dinamico: `delete $lnk/#ITextWidget` e `create IExpression` dentro); Link navega e passa
argumentos exatamente como Button; navegacao `set $btn/OnClick prop Destination value $acao` ou
`IMobileScreen:Tela` com argumentos `$btn/OnClick/<Input>`; ListItem nasce com swipe action sem destino (`delete
$item/RightActions/#IListItemAction`); Dropdown ligado a lista: `List` = `GetX.List`, `Values`/`Labels` no escopo do alias
(`User.Id`; numa variavel `T List`, o atributo: `Id`), nunca `GetX.List.Current.` nem variavel da tela (o Verify nao as identifica ali; o preflight recusa com `DROPDOWN_ITEM_SCOPE` e o patch); widgets compostos nascem com itens de exemplo (`"empty": true`); IRadioButton e IButtonGroupItem so se criam
dentro do grupo (pai = o grupo, o Content dele ou algo dentro dele; fora, o create e recusado nas duas faixas:
`tests/jobs-negative/create-radio-button-outside-group.json`). Roles: `link from $scr connector Roles to $role`.
Galeria completa dos nativos: `gallery-native-reactive.json`.

Listas devolvidas por data actions usam diretamente os atributos: `GetGames.Games.Current.Name` (entidade) ou
`GetKpis.Kpis.Current.Name` (structure). O wrapper `Current.User.Name` pertence ao resultado de um aggregate sem agrupamento;
com group by/agregacao, use os nomes das colunas (`Current.Orders`). `Hint Current` lista os campos reais quando o Verify
acusa um membro inexistente. Exemplos: `data-action-entity-list-reactive.json`, `data-action-reactive.json`, `aggregate-full.json`.
Static entity referenciada precisa ser publica no produtor (`"public": true` na spec ou `set $Status Public true`) e aparecer
em `elements` como `IStaticEntity:Status`; refaca o job produtor ou tire novo snapshot apos a alteracao. A FK so traz o tipo
Identifier. Veja `producer-static-public.json` + `consume-reference-static.json`; `producer-static-private.json` e o controle
negativo de `reference-static-not-public.json`. O erro de `reference` inclui a receita.

### 3.2 Traditional (tests/jobs/screen-crud-traditional.json)

New frontend by text: `tests/jobs/traditional-html-frontend.json` uses two `html` ops with `<block>`/`<screen>`
documents and one `logic` op with `data.flow` (`action Screen.Action`) in the same job. The compiler generates native
web widgets, variables, CSS and events; the screen actions run on the server. The example has a block, a field, a
button and a conditional answer. `TraditionalHtmlFrontendTests` checks the reload after a merge and that an existing
Entry is kept. The document creates an Entry only when the module has none, without writing DefaultScreen.
Recreation (B1) in Traditional too since 20/10/2026: `ScreenRecreationProof` visits `WebScreen`/`WebBlock`, the compiler
accepts `k`, `label for`, `os-*` on the root, extended attributes without a prefix, `ScreenAction:Name` destinations,
`WebBlockSignature:Name` blocks, moves `os-opaque`/`os-<Kind>` by k and returns `keys`; `Verbs.ScreenRecreation` moves the
Preparation and points the consumers of the root again. Proof: `tests/Anvil.Tests/TraditionalRecreationTests.cs`
(traditional-ui.oml, 5/5 equal).
Scope: div/span, text/expressions, input/textarea with bind, button/a with a destination without arguments,
table/tr/td, Block/slot, div if/else and list. Literal CSS/class. Unsupported markup is refused.
HTML editing of existing screens, JavaScript/React components and the `screen` generator stay outside this scope;
for existing screens, use the native verbs with @key. Publication and the browser need their own proof.

Before creating the initial entry of a Traditional module, read the existing `IEntry` elements. Without an initial
entry, create `OutSystems.Model.UI.Web.IEntry` in the flow, `link` the entry to the screen and `set IsDefault true` on the
entry. The CRUD recipe does this with `ContactsEntry` -> `ContactsWeb`. Do not change the existing default entry unless
asked to. The test `TraditionalEntryRecipeTests` checks the target and IsDefault after a save and a native merge; a valid
Verify and merge prove neither the compilation/publication on the server nor resolve every `ESpace.Dump` error.

`IWebScreen` em `IWebFlow:MainFlow` ja nasce com o layout do tema: os placeholders sao `$scr/#IWebBlockInstanceWidget/Title`,
`$scr/#IWebBlockInstanceWidget/MainContent`, `.../Actions`, `.../Breadcrumbs`. Dados na `IPreparation` (create no
`$scr`; Start, `IAggregateNode`, End, `link`, `layout`). Widgets com sufixo Widget: IContainerWidget, IExpressionWidget, IInputWidget
(Variable, Mandatory, MaxLength igual ao atributo), IButtonWidget (`set Label`, OnClick -> screen action), ILinkWidget (`Method`
Navigate, Destination = tela, argumento, e `link` tela -> tela para o conector do flow), ITableRecordsWidget (`SourceRecordList`,
celulas via `$tbl/HeaderRow` e `$tbl/DataRow`).

### 3.3 OutSystems UI (docs/ui/<Modulo>/README.md e blocks/<Bloco>.md)

Accordion, Tabs, Card, Columns, DatePicker, Dropdown Search, Sidebar, Carousel, Tooltip, ProgressBar... nao sao widgets nativos:
sao blocos do OutSystemsUI (Reactive/Mobile), OutSystemsUIWeb/RichWidgets (Traditional), OutSystemsCharts e OutSystemsMaps.
Cada bloco tem pagina com inputs (tipo, default, obrigatorio), valores possiveis, placeholders e o que nascem com, eventos,
blocos filhos esperados, APIs OSUI, CSS/JS e o trecho de verbos. Consulta rapida:
`dotnet .local/cli/anvil.dll ui-block --catalog catalog/ui/OutSystemsUI-2.28.1.json --name Tabs` (ou `--find dropdown`).
Blocos de dependencia INDIRETA (referencia oculta no modulo, ex. MouseEvents/TouchEvents): ao ligar `source`/`SourceBlock` o verbo
desoculta a referencia sozinho (`unhidden` no resultado); sem isso o merge automatico apagava handlers e argumentos da instancia
(`hidden-reference-block.json` e o teste MergeFidelityTests provam o merge de 3 vias headless sem perdas).
Instanciar: `create IMobileBlockInstanceWidget` com `"source": "IMobileBlock:<Nome>"` (`"empty": true` se o bloco traz conteudo
de exemplo); inputs `set $b/<Input> Value`; placeholders `$b/<Placeholder>`; eventos: screen action com um input por parametro,
`set $b/<Evento> Handler $acao` e `set $b/<Evento>/<Param> Value`; inputs do handler que nao usar geram `UnusedElement` (warning
esperado: declare cada aviso em `expectedMessages` com `why`). Blocos com Input de exemplo (DatePicker, Search, InputWithIcon, TimePicker): NAO use `empty`,
ligue `set $b/<Placeholder>/#IInput Variable`; os nomes reais do conteudo de exemplo sao renumerados (Input1), enderece por tipo.
Para saber que blocos o modulo ja referencia: um job com `{"op":"find","type":"IMobileBlockSignature","max":300}` (o template Reactive
traz 120 do OutSystemsUI). Se o bloco nao esta referenciado: verbo `reference` com nome do produtor ligado por `--producer Nome=<snapshot.oml>`. Datas: `Date Time` -> `Date`
com `DateTimeToDate()`, `CurrDate()`, `CurrDateTime()`. Galeria viva com o estado de cada um dos 176 blocos: `docs/ui/gallery-reactive.md`; as telas `Gallery_*`
publicadas no Headless_UI mostram como cada bloco fica. Regenerar quando a versao do ambiente mudar: `anvil ui-catalog`, `anvil ui-gallery`.

### 3.4 Spec de telas (op `screen`, Reactive e Mobile)

Prefira esta forma para catalogo, tabela, detalhe, formulario e dashboard. O compilador usa os blocos ja referenciados
no proprio modulo (Gallery/Carousel, CardSectioned, Search, Pagination, Tabs e Rating), sem caminho de catalogo.
Um job sobre fixture tem `base`, `expectValid:true`, `expectedMessages:[]` e `ops`; defina dados com `spec` antes de `screen`.
Exemplo completo de catalogo e detalhe (os tipos Id e os records estaticos sao gerados por `spec`):

```json
{
  "base":"reactive-ui.oml", "expectValid":true, "expectedMessages":[],
  "ops":[
    {"op":"spec","data":{
      "static":[{"name":"Genre","records":[{"name":"Adventure"},{"name":"Strategy"}]}],
      "entities":[{"name":"Game","public":true,"attributes":[
        {"name":"Title","type":"Text","mandatory":true,"length":120},
        {"name":"Description","type":"Text","length":500},
        {"name":"Price","type":"Currency"},{"name":"Rating","type":"Decimal"},
        {"name":"GenreId","type":"Genre Identifier"}]}]}},
    {"op":"screen","data":{"screens":[
      {"name":"Catalog","kind":"cards","title":"Games",
       "source":{"entity":"Game","as":"GetGames","sort":[["Game.Title","Ascending"]]},
       "search":{"field":"Title","label":"Search games"},
       "filters":[{"field":"GenreId","from":"Genre","label":"All genres"}],
       "card":{"title":"Title","description":"Description","price":"Price","rating":"Rating",
         "destination":"GameDetail","args":{"GameId":"GetGames.List.Current.Game.Id"}}},
      {"name":"GameDetail","kind":"detail","title":"Game details",
       "inputs":[{"name":"GameId","type":"Game Identifier","mandatory":true}],
       "source":{"entity":"Game","as":"GetGame","where":"Game.Id = GameId"},
       "tabs":[{"title":"Overview","fields":[{"field":"Title"},{"field":"Description"}]},
               {"title":"Pricing","fields":[{"field":"Price"},{"field":"Rating"}]}]}
    ]}}
  ]
}
```

Esquema fechado: chaves desconhecidas, campo inexistente, input sem uso, evento obrigatorio sem handler e `kind`
desconhecido falham na compilacao. Todas as telas/inputs sao criados antes das navegacoes: declare as telas de um app
no mesmo `screens`, em qualquer ordem. Uma tela existente nao e recriada; corrija o mesmo job antes da primeira entrega,
ou use os verbos para editar a tela existente. Traditional nao faz parte desta versao.

| Campo | Contrato |
|---|---|
| Comuns | `name`, `kind`, `title`, `inputs`, `source`, `search`, `filters`, `actions` |
| `inputs[]` | `name`, `type`, `mandatory` (padrao false), `default` (expressao). Devem aparecer em where/args/sort/metricas; texto entre aspas nao conta como uso |
| `source` entidade | `entity`, `as`, `where` (expressao ou lista), `sort` (lista de `[expressao,"Ascending"/"Descending"]`). Campos da tela sao nomes de atributos; expressoes em args usam `<as>.List.Current.<Entidade>.<Campo>` |
| `source` action | `action`, `as`, `output` (nome de output list, inferido se unico), `args` (mapa de expressoes), `total` (output inteiro). Gera data action; campos usam `<as>.<output>.Current.<Campo>`, sem wrapper de entidade. Para cards/table, args precisam passar `StartIndex` e `MaxRecords` e total deve informar a contagem completa |
| `search` | `field` Text, `label` opcional; usa Search e refresh automatico |
| `filters[]` | `field` FK, `from` static entity existente, `label`; a FK deve ter tipo `<from> Identifier`. Valor vazio significa todos |
| `kind:cards` | `card:{title,description?,price?,rating?,image?,layout?,destination?,args?}`; cada campo e um atributo. image e URL Text; layout e gallery (padrao) ou carousel. destination nomeia uma tela e args passa seus inputs |
| `kind:table` | `columns:[{field,label?}]` |
| `kind:detail` | `fields:[{field,label?}]` e/ou `tabs:[{title,fields:[{field,label?}]}]` |
| `kind:form` | `fields:[{field,label?,kind?,readonly?}]`; kind e input, textarea ou checkbox. Labels ligados aos inputs, obrigatoriedade vinda do atributo. Actions de gravacao ficam no Form, validam e so chamam o servidor com Form.Valid |
| `kind:dashboard` | `fields:[{label,value}]` (value e expressao, ex. `GetGames.Count`); pode ter card para uma galeria/carousel adicional. Home pode ser um dashboard com total de jogos e cards em carousel |
| `actions[]` | `name`, `label`, e exatamente um de `destination` (tela) ou `call` (action existente), mais `args` (mapa). Para gravar, crie antes uma server action wrapper por `logic`, e passe o record por args; entity action direta da tela nao e aceita |

Cards e table ganham variaveis StartIndex/MaxRecords (20 por pagina), Pagination com total do aggregate, handler
OnNavigate e Refresh Data. Search/filtros voltam a primeira pagina. Esses nomes de estado e `source.as` sao reservados:
nao os redeclare como inputs. Gallery e Carousel conservam sua List e substituem apenas os widgets de exemplo dentro dela;
a spec nao precisa nem deve criar IList, eventos ou ligacoes por fora.

Exemplos testados: `screen-spec-cards-reactive.json`, `screen-spec-cards-mobile.json`, `screen-spec-table-reactive.json`,
`screen-spec-detail-tabs-reactive.json`, `screen-spec-form-reactive.json`, `screen-spec-dashboard-reactive.json` (inclui
fonte de data action). `screen-spec-store-reactive.json` e a prova fria Home/Catalog/GameDetail,
validada na primeira tentativa por outra LLM lendo apenas esta secao. Negativo: `screen-unknown-kind.json`. Todos os dados dos exemplos vivem no mesmo job, sobre fixture.
Provar: `ANVIL_LANE=ss5 python scripts/run_job.py <job>.json`; no PowerShell, defina `$env:ANVIL_LANE='ss5'` antes.
Entregar: `anvil deliver --module Headless_UI --job <job>.json --checks Catalog,GetGames,Pagination1,CardSectioned1`.
Para uma prova nova, guarde o job em `.local/lane-ss5/` e use o caminho explicito; nao reutilize OML gerado como base.

### 3.4.1 Telas padrao de entidades (`screen` com `data.generate`, gen-screen/1)

O modelo nao escreve lista, detalhe e formulario de uma entidade: `{"op":"screen","data":{"generate":{"entities":["Customer","Order","Product"]}}}`.
O gerador (`ScreenGenerator.cs`; leitura do modulo e compilacao em `Verbs.ScreenGenerator.cs`) le as entidades (do modulo e das
referencias), as actions que o modulo pode chamar e os blocos, e escreve documentos `ssam-html/1` e textos `ssam-flow/1` que a forma
documento da op `html` e a op `logic` compilam (as mesmas regras do dono, o mesmo ponto fixo): lista em `<table class="table">` com
`<tbody list>`, paginacao, busca nos atributos de texto, dropdown por referencia a static, cabecalhos ordenaveis (sort dinamico),
estados de carregando, erro e vazio; detalhe em tabela de duas colunas; formulario com inputs tipados pelos atributos, dropdown por
referencia, validacoes nativas e Save; delete com confirmacao. Leitura por aggregate ou por action achada pela assinatura (lista
da entidade com inputs de paginacao e total; registro por identificador); escrita por action achada pela assinatura (save: um input
obrigatorio que e o registro; delete: um input obrigatorio identificador e verbo de delete no nome) ou por `<E>_Save`/`<E>_Delete`
criadas uma vez em volta das entity actions (a tela nunca grava do cliente). Entidade so leitura sem action: lista e detalhe, sem
formulario nem delete (`gaps`). Blocos: layout, paginacao, confirmacao e barra de filtros achados pela assinatura no modulo ou nas
referencias; o que falta e criado uma vez (`Pager`, `ConfirmDialog`, `FilterBar`, `PageHeader`) ou, com `blocks:"inline"`, vira
markup. Cada raiz leva `ssam:gen-screen/1 <sha>` na descricao: o mesmo pedido sobre o modulo que ele produziu e `NO_CHANGE`. Nome
ocupado por algo nao gerado: recusa com o patch do nome livre (`entities[].names`). Recibo: `results[].result.generate`.

### 3.5 Autoria HTML/CSS (op `html`, Reactive e Mobile)

A LLM escreve a pagina inteira em HTML/CSS mais um manifesto tipado; o compilador (HtmlExpander) converte em widgets nativos
pelos mesmos verbos: `div` -> Container (classes em Style), as outras tags suportadas -> HTML Element (`Tag` + atributos como
extended properties), texto -> Expression; `input`/`select`/`button`/`a`/`label`/`table` -> Input/Dropdown/Button/Link/Label/
TableRecords; `input type="date"` -> bloco DatePicker do OutSystemsUI com handler OnSelected. Ordem, aninhamento, classes, `aria-*`,
`data-*`, `role`, `title` e `style` inline sao preservados. A pagina nasce dentro de um Container `Page` com a classe `av-<tela>`;
o CSS (`<style>` e `data.css`) e analisado, reescrito sob essa classe (`:root`/`body` viram a raiz) e instalado no CSS do
AUTOR do tema padrao do modulo (a metade que o Studio edita; veja **CSS do tema** na secao 2) entre marcadores
`/* anvil:html <Tela> */` (o fragmento usa `/* anvil:html <dono>:<classe> */`, dono = tela ou bloco que recebe o fragmento; um bloco
legado `/* anvil:html <classe> */` e adotado uma vez pelo primeiro dono, `adoptedLegacy`, nunca copiado), substituidos a cada
compilacao (`stylesheet: "none"` desliga). `api --op html` lista tags, atributos, kinds e chaves. Fonte canonica: `tests/html/incidents-dashboard.html`
+ `.bindings.json` (+ `.fixture.json` com spec/logic/screen stand-ins das actions do Incidents_CS; `.product.json` com o `reference`).
Jobs derivados por `scripts/gen_html_job.py --target fixture|update|product`: `html-dashboard-reactive.json` (cria a tela sobre
reactive-ui.oml), `html-dashboard-update.json` (a mesma pagina outra vez sobre `job:html-dashboard-reactive`: delta) e
`tests/jobs-live/html-dashboard-incidents.json` (produto; base = snapshot do deliver, `--producer Incidents_CS=<snapshot>`).

Op: `{"op":"html","data":{"screen","title","html","css?","stylesheet?","vars?","sources?","search?","filters?","derived?","scripts?","bindings"}}`.
`vars` declara variaveis da tela (`name`, `type`, `default`). `sources[]` (ou `source`): entidade (`entity`, `as`, `where`, `sort`,
`max`) vira Aggregate; action (`action`, `as`, `args`, `outputs?`) vira Data Action expondo TODAS as saidas da action (`<as>.<Saida>`,
listas em `<as>.<Saida>.Current.<Campo>`). `search` (`key`, `variable`=SearchText, `field` so em entidade, `label`) e `filters[]`
(`key`, `from` static, `variable`, `field`, `label`) declaram a variavel, o controle e a action de refresh; com action sources a
variavel tem de ser passada em `args`, senao e erro. `derived[]` (`name`, `type`, `source`, `output`, `max`|`sum` de um campo) gera
variavel + screen action `Derive<Nome>` (ForEach/If/Assign) ligada ao OnAfterFetch da source: logica nativa no lugar de script.
`scripts[]` (`name`, `inputs`, `outputs`, `code`) viram client actions Function com um no JavaScript (inputs so de tipos basicos:
lista de estrutura e recusada pelo Verify), chamaveis nas expressoes dos bindings. Bindings por chave (`data-av="chave"`), esquema
fechado: `text` (`value`), `list` (`source` = source declarada ou `{"variable":"<Lista de vars>"}`, `output`; num `<table>` ->
TableRecords com `<thead>` de um `<tr>` e `<tbody>` de UM `<tr>` template; num `<div>/<ul>/<ol>/<section>` -> List cujo unico filho e
o template), `field` (so dentro de um `list`), `style`/`class` (expressao que se soma ao atributo estatico), `visible` (`condition`,
em QUALQUER elemento: vira um If nativo `If<Chave>` no lugar do elemento, Condition = expressao, o elemento nasce no ramo True; nunca a
propriedade Visible), `date` (`variable` Date/Date Time declarada em `vars`, `format`), `navigate` (`destination` tela existente +
`args` conferidos), `call` (`action` + `args`; server/service/client action do modulo ou de um op `logic` ANTERIOR do job -> handler
`<Nome>Handler` com Refresh Data; screen action DESTA tela declarada por um op `logic` do mesmo job, antes ou depois -> a pagina cria a
action primeiro (nome, inputs, outputs) e liga o OnClick direto nela; o op `logic` seguinte vira `replace` e preenche o corpo mantendo a
chave, relatado em `sameJobScreenActions`) e `refresh` (`sources?`). Clique (`navigate`/`call`/`refresh`/`page`) num elemento que nao e
`<a>`/`<button>` mantem o elemento e a tag (HTML Element com evento `onclick`; a lane compile prova no Verify; fallback
`ElementWidgetMap.ElementEvents=false`: Link com `ssam-tag-<tag>`).
Qual widget cada elemento vira e a tabela UNICA `Kernel/ElementWidgetMap.cs` (a mesma do fragmento e do importador de prototipo,
`PrototypeSeams.Element`): tags do HTML Element congeladas por plataforma (103 O11, 100 ODC sem `data`/`main`/`picture`, um teste as
reextrai das DLLs instaladas), substitutos fixos (`br` Container vazio; `main` no ODC, `search`, `menuitem`, elementos customizados ->
div com `ssam-tag-<tag>`; `data`/`picture` no ODC -> span), tabela estatica = HTML Elements das suas tags, `<label>` com filhos = HTML
Element `label` com os filhos (bindings inclusive), `<button>` vazio com `aria-label`/`title` aceito, botao de envio nunca `type=submit`
(`IsDefault` + `ssam-submit`). Atributos: todos preservados; fora da antiga lista fechada (`tabindex`, `name`, `min`, `max`, `step`,
`minlength`, `form`...) viram extended property literal, `disabled` vira `Enabled = False` num controle, JavaScript inline (`on*`) e
recusado. `id`: nomeia o widget de um elemento sem `data-av` (sanitizado: `header-search` -> `header_search`; chave `data-av` repetida =
o mesmo binding em cada elemento, `Fv284`, `Fv284_2`...) e nunca e emitido como atributo (o OutSystems reserva, `InvalidHTMLAttribute_Id`);
seletor CSS por id (`#x`) continua recusado: use classes. `@import` (em qualquer linha, pelo parser) sobe para o topo do CSS do tema,
uma vez (`cssImportsHoisted`), nas formas pagina e fragmento.
Recusa: TODOS os problemas da pagina numa resposta (por elemento, por chave, por statement de CSS; o problema de um elemento nao esconde
os filhos), cada um com codigo `HTML_*`, fix proprio e `patch` quando a correcao e certa (`HTML_BINDING_ORPHAN` -> `remove` do binding,
a ordem dos ops nao importa: F5, `JobComposition` roda o op `logic` que declara a action antes do html). O preflight (check-job, sem modulo) roda a MESMA passada de widgets com
escopo vazio e confere `call` contra os ops `logic` do job; o que ele ja recusou nao e aplicado de novo (`RefusedWhole`), e as
construcoes que a forma antiga recusava saem como avisos com contagem (`CSS_IMPORT_HOISTED`, `HTML_KEY_SHARED`,
`HTML_SCREEN_ACTION_SAME_JOB`, `HTML_CLICKABLE_ELEMENT`, `HTML_ATTRIBUTE_EXTENDED`, `HTML_VISIBLE_IF`, `HTML_TABLE_STATIC`,
`HTML_LABEL_CHILDREN`, `HTML_CONTROL_LABELLED`). Continuam recusados com diagnostico: `<script>`, `<form>`, `<dialog>`, `<img>`, `<svg>`,
`<link>`, `<textarea>` (a forma fragmento ou o importador compilam), tag fora das listas sem substituto, botao/link sem binding,
`<input>`/`<select>` sem search/filter/date. `<a>`/`<button>` so com texto usam a legenda do proprio widget; com elementos filhos os
filhos viram widgets filhos do Link/Button (a legenda nativa e apagada), nas duas faixas; dentro deles sao recusados outro clicavel,
`input`/`select`/`label`, tabela com `list`, `list`, `block`. `api --op html` publica essas regras (`kindTags`, `platformTags`,
`extendedAttributes`, `names`, `call`, `css`). Provas: `HtmlPageCollectAllTests` (H1-H16 sobre os jobs 79/88/105 da FarmaVirtual em
`tests/Anvil.Tests/Fixtures/html-page`), `ElementWidgetMapTests`, `HtmlDeltaTests` (Verify da pagina com as nove causas, blocos do tema),
`tests/jobs/html-if-links-reactive.json`, `tests/jobs-odc/html-if-links.json`, `tests/jobs-negative/html-control-inside-link.json`.

Tela existente: o op limpa o conteudo, o titulo, as data actions, os aggregates e as screen actions da tela (tudo interno a ela;
um evento de ciclo de vida ligado a uma screen action da tela e desligado no mesmo op e citado em `delta.removed.lifecycle`), mantem a chave da tela, inputs, roles e as variaveis que a pagina declara com o mesmo tipo
(tipo diferente e erro), recria a apresentacao e poda variaveis antigas so quando nada as usa. O resultado traz `mode` create|update,
`delta` (removidos com chaves, variaveis mantidas/podadas), `keys`, `sources`, hashes do HTML/CSS e o tema instalado. Provas:
`HtmlSpecTests` (parsers, ops iguais para a mesma fonte, estrutura, negativos) e `HtmlDeltaTests` (chaves da tela e das variaveis
iguais apos a segunda compilacao, um bloco no tema, merge de 3 vias sem conflito). `anvil merge-probe --base <snapshot.oml> --foreign <resultado.oml> [--out <merged.oml>]`
repete headless o merge de 3 vias do Studio (objetos, Verify, conflitos) antes de entregar. Renderizacao no navegador e entrega ao Studio
do Incidents_UI continuam pendentes do acesso autenticado ao controlador (docs/tasks/2026-09-05-plano-autoria-html-dashboard.md, secao 8).

Autoria **visual** (fragmento HTML/CSS dentro de um pai que ja existe, sem logica: a logica, dados, eventos e parametros continuam
nos verbos nativos): `{"op":"html","parent":"$tela/...","file":"tests/html/visual/alert.html"}`. Tabela fechada de tags/atributos e
provas em `docs/UI-HTML-VISUAL.md`; jobs `html-visual-alert.json`, `html-visual-list.json`, `html-visual-block.json` (`HtmlVisualTests`).
Pai = a propria tela: o fragmento vai para o placeholder de conteudo do layout. `{{ }}` na legenda de botao/link vira Expression;
`<label>` com filhos vira HTML Element `label` com eles; botao so com icone (ou vazio com `aria-label`/`title`) e aceito; toda tag do
HTML Element da plataforma (tabela estatica inclusive) e `<form>` (Form) compilam pela tabela unica; `<br>` vira Container vazio; `<ButtonGroup bind>` com
`<ButtonGroupItem value>` segue a rota nativa; o tipo da variavel decide o InputType. CSS: `light-dark()` e expandido, `color-mix()`
e recusado com a cor calculada (`CSS_FUNCTION_UNSUPPORTED`; tambem em `set StyleSheet`). Todos os problemas do fragmento numa recusa so.
O compilador JS de componentes (`HtmlComponents`, `data.components`) e legado: nao usar em trabalho novo.

Faixa ODC (WS1): o mesmo kernel compila contra o ODC Studio em `src/Anvil.Core.Odc` (adaptador `Adapters.ODC`, ver o
README la) e os mesmos ops correm headless sobre `tests/fixtures/odc/insurance-reactive-r8.oml` pelos jobs de
`tests/jobs-odc` (`data-entity`, `logic-action`, `screen-basic`, `html-visual-{alert,list,block}`): prova
`dotnet test tests/Anvil.Tests.Odc -c Release`. Diferencas de API entre as plataformas e como o kernel as trata:
`docs/tasks/2026-09-17-ws1-diferencas.md`. O CLI dessa faixa e `src/Anvil.Cli.Odc` (`anvil-odc`, construido por
`python scripts/build_odc.py` para `.local/lane-odc/cli`, com worker residente como o da faixa O11):
`python scripts/run_job.py <job> --lane odc` aplica um job pelo kernel ODC (worker: ~3 s; frio: ~14 s) e imprime o
mesmo resumo da faixa O11; `anvil-odc deliver` entrega ao ODC Studio aberto pela bridge (WS2). Tabela em `docs/lanes.md`.

## 4. Quando o Verify falhar

O `apply` devolve `Severity Id: Titulo @ caminho`. Consulte `anvil verify-message --name <Id>` ou `--find <texto>`: IDs, severidade e textos vem da DLL instalada;
os hints curados tambem aparecem no runner. `docs/diagnostics/verify-messages.md` explica essa separacao. Quando o Studio e
atualizado, os manifestos do repo regeneram-se com `anvil verify-message --out catalog/verify-messages-<ver>.json` (na faixa ODC,
`anvil-odc verify-catalog --out catalog/odc/verify-messages-<versao>.json`: um job ODC declara `expectedMessages` contra essa lista,
que tem avisos so do ODC como `UnusedGlobalEvent`, prova `tests/jobs-odc/global-event-unused.json`) e
`anvil functions --out catalog/functions-<ver>.json --docs docs/functions.md` (so ids e metadados; texto do fabricante nunca
entra). Sem isso, `SurfaceTests` e `FunctionCatalogTests` ficam vermelhos a apontar o ficheiro que falta. Erros comuns e correcao: `RequiredPropertyValue_*` (falta valor: input, Variable, Source, Destination);
`RequiredConnector_*` (no sem `link`); `InvalidFlow_NoStart` (fluxo sem `IStartNode`); `ExpressionUnknownObject` (nome errado ou
fora do escopo; em Dropdown use o alias da lista); `DisconnectedDestination` (Traditional: falta `link` tela -> tela);
`ExpressionUnknownFunction` (a funcao nao existe: leia a linha `Hint UnknownFunction` logo abaixo, que da as parecidas, e
`docs/functions.md`); `InvalidDataSet_LocalEntitiesInServerAggregate` (aggregate sobre client entity sem `isClientSide`); `UnusedElement` e
`UnusedUserAction` (warning: ligue ou marque Public); `CustomObjectWarning` Security Warning (tela chamando entity action: wrapper).
Avisos de seguranca (T12, `SecurityWarnings.cs`) bloqueiam sempre que novos, inclusive o `CustomObjectWarning` cujo titulo e de uma familia de seguranca (`SQL Injection | ...` do ORDER BY com Expand Inline); a recusa traz o fix e o patch de aceite em `expectedMessages` cujo `why` tem de ser as palavras do usuario (placeholder ou reticencias sao recusados). Mudanca TEMPORARIA de acesso numa app de origem (comparar telas protegidas): job com `"temporary":{"restore":true}` e so `set Roles`/`set AnonymousAccess`; o recibo traz `accessChanges` e `accessRestore` (ops com `ifCurrent`), o `ssam_doctor` lista a restauracao pendente (a mais nova primeiro) ate ela voltar, e `"temporary":{"close":"<id>"}` com as palavras do usuario a encerra. O digest mostra `access=` e `roles=` de cada tela (`NO_ROLE_SCREEN`: nenhuma conta abre; nao peca para trocar de conta).
`ExpressionUnknownObject`, `RequiredPropertyValue_*` e `CHILD_NOT_FOUND` em massa costumam ser cascata de um op raiz: desde a fase
scope (R1, 24/10/2026) eles chegam antes do build como SCOPE_UNKNOWN_IDENTIFIER, WIDGET_REQUIRED_PROPERTY e OWNER_CHILD_EXISTS, e a
recusa nomeia o op raiz em SCOPE_BLOCKED_BY_REFUSED_OP: leia-o primeiro.
O job e uma SEQUENCIA: o alvo de um `set`/`link` (tela de destino, action chamada) tem de existir ANTES desse op. Se nao existir, o erro
diz `op #4 (set Destination): ... IMobileScreen:Catalog does not exist yet at this point of the job: it is created at op #6 ...` e lista
todos os outros forward-refs do job (`Also out of order: ...`): mova os creates para antes, ou os sets para depois (exemplo negativo:
`tests/jobs-negative/destination-before-screen.json`). O erro traz sempre o prefixo `op #i (verbo prop)`.
Erro do proprio verbo (antes do Verify) diz o que faltou: `no X named Y; objects with that name: ...`, `has no child 'Z' (children: ...)`,
`cannot create T (no Create method)`, `delete: refused, used by ...`. "can't be children of" = o runtime do modulo nao aceita:
veja `docs/mapa/criar-<fixture>.md` e a coluna "Onde pode".

## 5. Bridge do Service Studio (porta 4516, scripts/anvil_client.py)

A entrada preferida para um Studio aberto é `ssam connect --lane o11 [--pid <PID>]` na raiz.
Ela conecta à instalação normal em runtime ou reutiliza a bridge existente. Não fechar/reabrir o Studio nem
salvar/publicar para anexar; módulos inválidos e não salvos são permitidos. Guia e limites de prova:
`../docs/CONEXAO-STUDIO.md`. Os launchers de clones descritos abaixo são caminhos legados, não recuperação do attach.

`get_active_module`, `snapshot_module`, `merge_from_oml` (preview|auto), `get_errors`, `find_element`, `get_flow_nodes`, `login`
(arquivo de credenciais; nunca imprima senhas), `open_module` (seleciona a aba), `publish` (so testes; a falha traz
`data.publishLog`), `publish_log {module?, max?}` (le a aba 1-Click Publish do Studio: ultima publicacao do modulo, quem quer
que a tenha feito, com etapa, texto e elemento; `PublishLogHandler.cs`, so leitura), e para troubleshooting
`windows`, `ui_alive`, `close_dialog`, `python scripts/cdp_pages.py` (le e clica dialogos web pelo CDP 9226; depois de matar o
Studio aparece o dialogo de recuperacao: `--click Discard`). Abrir o Studio: `scripts/open_ss4.ps1`.
Abertura: `open_module` usa `silent:true` por omissao, so durante o carregamento; devolve `referencesOutdated`,
`referencesCheck:complete|skipped` e `serverSilentMode:false`. Referencias antigas ficam para o humano atualizar;
o modo silencioso e reposto tambem em timeout. `silent:false` conserva a pergunta normal do Studio.
`close_module {name}` so fecha uma aba guardada, aberta e sem dialogos; recusa edicoes locais ou nomes duplicados.
`open_module` prefere a unica aba com edicoes quando ha uma copia limpa do mesmo modulo; recusa varias copias editadas.
Dialogos: `open_module` NUNCA fica mudo; com um dialogo aberto devolve em <= 5 s `{opened:false, blockedBy:[{kind, title, texts, hint}]}`
(kinds: Recovery, ManageDependencies, MergeEditor, MessageBox, Modal); a bridge nao clica por si: responda no Studio ou com
`cdp_pages.py --click <Botao>` / `close_dialog` e chame outra vez. `merge_from_oml` recusa quando ha dialogo/editor pendente ou o
modulo ja tem estado de match ("Matches cannot be set already" = dialogo de referencias/merge aberto; nunca reinicie o Studio por isso);
`get_active_module` mostra `activeMatch` e `pendingDialogs`. Todos os caminhos passados a bridge (`path`, `foreign_path`, `base_path`, `out_dir`,
`credentials_file`) sao ABSOLUTOS: a bridge corre no processo do Studio e um caminho relativo cairia na pasta da instalacao; um
relativo e recusado com o verbo, o parametro e o cwd.
Service Center pelo login do proprio Studio (SSO incluido; contrato no `CONTRATO.md` da integracao, secao O11):
`sc_api {host, surface: soap|server-api|sc-rest, operation, args, write?, operationId?, authorizeSha256?, target?,
corporateInstruction?}` faz UMA chamada de uma lista fechada (`bridge_manifest.serviceCenter`) com o cliente do Studio
logado nesse host e segredo novo a cada chamada, sem o wrapper do Studio que reenvia. Escrita exige os campos da fachada,
nunca e reenviada (excecao depois do envio = `UNCERTAIN`; operationId repetido e recusado) e no ambiente corporativo exige
`corporateInstruction:true`. Fechadas: SetupAdminUser, TestAction, TestQuery, Upload/DeleteProductLicense, SynchronizeApps,
PushProducerToConsumer, ImportTable, RegisterOperation, Metrics_*. Binarios: `args.outFile` absoluto (nunca sobrescreve) ou
base64 ate 16 MiB. `sc_web {host, action: status|open|login|fetch|close}`: janela do Service Center dentro do Studio;
`open {hidden:true}` a mantem fora da tela e da barra de tarefas pela vida toda, e `login` (capacidade `sc_web:login`) a loga
com `SSAM/O11/<host>/ServiceCenter` do cofre, digitado so no formulario de login do proprio host ou de `id.outsystems.com`, um
envio por chamada (`WEB_LOGIN_REJECTED` / `WEB_SIGN_IN_INTERACTIVE`, nunca reenviado nem mostrado; `ScWebLogin`); sem `hidden`
o usuario entra nela uma vez; `fetch` e um fetch() da mesma origem so sob `/ServiceCenter/` (postback que muda estado leva os campos
de escrita). Segredo (senha/usuario de Database Connection, site property secreta) NUNCA vai no `form` pela fachada: o
postback de escrita leva `secretRefs [{field:<campo do form>, target:'SSAM/O11/<host>/<entrada>', part:password|username}]`
ou, como a fachada manda, `[{pointer:'/<campo do form>' (RFC 6901), target, field:password|username}]` (capacidade
`sc_web:secretRefs`; o campo fica no form com um placeholder) e a bridge le a credencial generica do Cofre do
Windows dentro do Studio logo antes do envio; a resposta mascara o eco e apaga o `__OSVSTATE` (releia por GET); entrada
ausente = `SECRET_NOT_FOUND` com o alvo; alvo de outro host = `HOST_MISMATCH`; os logins do ambiente nunca entram num form
de postback (o unico caminho do login ServiceCenter e o formulario de login, pelo `sc_web login`).
`studio_login {host}` abre o login do proprio Studio; `sc_session {host?}` mostra sessoes, janela e
capacidades. Respostas `{success, data:{ok, code?, ...}}` sem segredo; o log da bridge guarda so o tamanho. Codigo:
`src/Anvil.Bridge/Sc*.cs`; testes `ServiceCenterBridgeTests`. A bridge nova vale no proximo Studio aberto pelo hook.
Trocar de ambiente sem GUI: `python scripts/studio_env.py login --credentials <arquivo .credentials.json> [--open <Modulo>]`
(o Studio mantem UMA ligacao; o login substitui a anterior e nao toca em nada do ambiente anterior; `status` mostra o ambiente
ligado e os modulos abertos). Cada ambiente tem o seu arquivo de credenciais fora do repo; o script so imprime host e utilizador.
FAIXAS (uma por sessao, `scripts/lanes.py`): `ANVIL_LANE=ss4` (omissao: SS4 — em `scripts/lanes.py` e no CLI por valor fixo; na fachada
`ssam`/descoberta por `o11Lane` de `.ssam-workspace.json`, que hoje diz `ss4`, e sem nenhum dos dois a fachada recusa em vez de assumir; um
`ANVIL_LANE` explicito prevalece sempre — bridge 4516, CDP 9226, worker 4517, pastas `.local/`) ou
`ANVIL_LANE=ss5` (SS5, bridge 4536, CDP 9246, worker 4537, pastas `.local/lane-ss5/`). Todos os scripts leem a variavel; duas
sessoes trabalham em paralelo sem se tocar, uma em cada faixa; dentro de uma faixa o Studio tem UM modulo ativo de cada vez.
Abrir o Studio de uma faixa: `scripts/open_studio.ps1 -Lane ss5` (clona a instalacao uma vez, injeta a bridge e abre); o CLI da
faixa: `dotnet build src/Anvil.Cli -c Release -o .local/lane-ss5/cli`. Nunca reconstrua `.local/cli` nem reinicie o worker 4517
se outra sessao estiver na faixa ss4: use a sua faixa.

## 6. Onde esta o resto

Para criar um app, consulte primeiro `recipe`, `where-can`, `verify-message` e `api --op` conforme a duvida;
leia apenas a secao e o job indicados. Nao leia todo `src/` preventivamente. Se precisou abrir `src/` para descobrir
como expressar uma tarefa, registre a pergunta: e um bug da superficie de comandos/documentacao. Investigacao e
manutencao do proprio Anvil naturalmente exigem codigo. Em provas frias, conte separadamente leituras preventivas,
consultas reativas apos erro e invocacoes de comandos.

`MANIFESTO.md` (principios; leia antes de mudar rumo), `docs/architecture/` (produto, verbos, plano), `docs/PROVAS.md` (todas as
provas com numeros e comandos), `docs/mapa/` (o que cada runtime cria + investigacoes: referencias, refatoracao, REST),
`catalog/model-api-11.55.69.json` (todas as interfaces e propriedades), `catalog/ui/` e `docs/ui/` (blocos), `docs/diagnostics/`.
Nao traga codigo do SSAM antigo; se precisar, pasta `Legacy`. Nunca comite OMLs de cliente, binarios da OutSystems ou credenciais.

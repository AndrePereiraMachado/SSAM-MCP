# Descoberta contextual de capacidades e contratos

Data: 22/09/2026 (rodada 3: fechamento). Estado: **implementado e testado na faixa ODC** (checkout isolado
`claude/contextual-discovery`); **não ativado** na raiz operacional; avaliação de eficiência: §7.

Uma consulta recebe uma intenção de trabalho, a faixa e, opcionalmente, uma captura, e devolve **numa só resposta**,
dentro de um orçamento em bytes: as capacidades correspondentes com a operação pública exata, os contratos extraídos do
kernel inteiros, um excerto de exemplo por capacidade, as regras de ligação comprovadas pelos jobs de prova, o fecho de
dependências com condições de reutilização, as assinaturas relevantes da captura, decisões, limites com origem, o que
está indisponível e o caminho de validação. O que ficou de fora é nomeado com a continuação exata; uma segunda chamada
em lote (`--expand`) devolve só o que faltou. Não executa, não entrega e não substitui a validação nativa.

## 1. Uso

```powershell
.\ssam discover "Criar um formulário com dropdown pesquisável, carregar dados e salvar"
.\ssam discover "lista de apólices com static e navegação para detalhe" --app kernel\tests\fixtures\odc\insurance-reactive-r8.oml
.\ssam discover --expand ui.list:example+bindings,logic.aggregate:example,contract:logic.steps.get      # continuação em lote
.\ssam discover --expand element:MobileBlockSignature:DropdownSearch --app <captura.oml>              # uma assinatura da captura
.\ssam discover --detail ui.form                      # = --expand ui.form:contract+example+evidence+bindings
.\ssam discover --detail ui.dropdown --type IDropdown # + native:IDropdown (metadados A)
.\ssam discover "..." --budget 24576                  # orçamento em bytes UTF-8 (padrão 40960; limite duro, ver size.status)
.\odc discover "consumir uma API REST com POST"       # a mesma entrada pela fachada ODC
.\ssam discover "criar uma entidade Order com FK para Customer e um indice unico composto" --lane odc --budget 12000
.\ssam discover "renomear o atributo Email da entidade Contact e apagar o atributo Phone" --lane o11 --budget 12000
.\ssam discover --expand data.entity:operations+native+evidence --lane o11   # o que a resposta reduzida omitiu, inteiro
```

A descoberta diz COMO expressar um pedido; para ler a aplicação em si, comece por `ssam map` / MCP `ssam_map` e
leia depois por `@key` com o sha256 esperado ([leitura rápida](LEITURA-RAPIDA.md)). `--app` usa o mesmo mapa nas
leituras por kind.

Faixa: `--lane odc` (padrão) ou `--lane o11`; sem `--lane`, e sem `ANVIL_LANE` no ambiente, a faixa O11 do índice vem de
`o11Lane` em `.ssam-workspace.json` (`ss4`); `ANVIL_LANE=ss4|ss5` sobrepõe; sem nenhum dos dois a fachada recusa em vez
de assumir.

MCP: `ssam_discover {intent, lane?, app?, expand?, detail?, type?, limit?, budgetBytes?, rebuild?}` no servidor da
fachada ODC, relayed pelo servidor `ssam`. Somente leitura. Sem `intent` e sem `expand`/`detail`, lista as capacidades.

Um job de laboratório pode viver fora do repositório: o campo `base` (`tests/fixtures/...`) resolve contra as fixtures
do kernel em execução (rodada 3, `JobSources.KernelRoot`); `--base` na linha de comando continua a sobrepor.

### 1.1 Resposta composta (`schemaVersion: ssam-discovery/4`)

| Campo | Conteúdo |
|---|---|
| `tools[]` | (entrada única, 03/10/2026) só quando a intenção pede uma operação do SSAM, logo após `intent`: até 3 itens `{tool, verb?, lane, args, when, preconditions?, next?, why, filled?, otherLane?/note?, equivalent?, legacy?, supersedes?}`, ou `{gap, lane, when}` para uma operação que nenhuma ferramenta faz. `args` é o modelo da chamada (`<placeholder>` a preencher; palavras do usuário, UUID e credencial nunca vêm preenchidos; nomes como `abrir o módulo Pedidos` preenchem o slot e vêm em `filled`). Rotas em `platforms/odc/facade/catalog/tools.json` (`ssam-tool-routes/1`), lidas por `tool-routing.mjs` com vocabulário próprio: o casamento de capacidades nunca lê esse arquivo e a resposta de mudança de modelo é o objeto do `discover()` sem alteração (sem a chave `tools`). Regra de modelo: um passo do pedido cujas palavras não explicadas pela rota ainda casam uma capacidade de modelo (`via: match`) só recebe ferramentas de `effect` `read` ou `delivery` (`tools.json`, conferido com `readOnlyHint`/`destructiveHint`), o `hint` começa por "Model change: matches" e nunca diz que não é mudança de modelo, e a parte de modelo nunca é refeita com orçamento menor nem cortada; passos sem capacidade de modelo (o publicar de "criar a entidade X e depois publicar o módulo") mantêm a ferramenta. Ferramenta da outra faixa: `otherLane: true` e `note`. Intenção vazia (12/10/2026): `ok:false`, `code` INTENT_REQUIRED, abaixo de 1 KB, com o formato exato da chamada (`shape`), a `continuation` que mantém o `app` pedido e a chamada do catálogo; nada do índice é lido. `catalog:true` (sem intenção) responde `ok:true` com `categories`, `capabilities`, `coverage`, `toolGroups` (todas as ferramentas da faixa por grupo, com os verbos) e `otherLaneTools` |
| `identity` | hash do CLI e do `Anvil.Core.Odc.dll`, Studio medido (`verify-catalog`, versão, hashes dos assemblies comparados), sha da fixture, hash do descritor, jobs (total, com resultado, `current`, `historical`), versão do índice nativo, `cache`, `warnings` |
| `matches[]` | por capacidade: `via` (três camadas, fase 3: `match` = a intenção nomeia um elemento da capacidade, ou uma capacidade sem elementos casa por palavras; `dependency` = exigida por um match direto; `alternative` = só palavras de operação casaram, ou a capacidade é alternativa declarada de um match — vem compacta: `id`, `reason`, `level`, `route.kind` e `expand: <id>` para a abrir inteira, nunca com contratos), `why`, `level` (`B`, `route`, `C-suite`, `C-executed-historical`, `C-executed-current`), `route`, ponteiros de `contract`, `proofs` (job + nível + nº de divergências), `depends` (`{id, unless}`), `requiredBy`, `conditions`, `existingInCapture` (com `--app`); matches diretos trazem `summary`, `negative`, `limits` (texto + origem), `guidance`, `notes`. Uma família de dados nomeada só por uma palavra genérica de filho (`atributo`) quando outra família é nomeada pelo seu elemento próprio desce a `alternative`; sem nenhum elemento nomeado (`"reapontar e apagar"`) as famílias vêm como alternativas e o `hint` diz que palavras nomeiam o elemento |
| `contracts` | os trechos de `api --op` apontados pelos matches diretos **inteiros** (até 6 KiB por trecho; acima disso, chaves + `expand: contract:<ponteiro>`); dependências em forma compacta |
| `examples` | por match direto: as primeiras 8 ops (dos verbos da capacidade) do job de prova mais representativo, com `job`, `base`, `fragment`, `opsShown/opsTotal`, `undefinedAliases`; numa capacidade partilhada cuja intenção nomeia o papel e a operação, o excerto é restrito (`scope: {role, op, native, level, attribution, proves, observed?}`) às ops do job de prova DESSE papel que o resultado executado atribui ao tipo nativo do papel (verbos da operação mais `usages/get/dump` no mesmo tipo); `focusedOps` (fase 3) são as posições, no excerto, das ops dos verbos em foco — um corte (por `max` ou por orçamento) guarda-as primeiro e mantém a ordem do job; um `spec` é atribuído aos tipos das formas que declara (entidades, static, structures) que o ledger do job regista como criados |
| `bindings[]` | regras de ligação comprovadas, extraídas dos jobs de prova dos matches (`set <IListItem>/OnClick Destination = IMobileScreen:<name>`, `set <IList> Source = <Aggregate>.List`, `set <IListItem>/OnClick/<argument> Value = ...`), com o op concreto, o job e o nível; ligação elemento→elemento primeiro, depois dados, depois fluxo/argumentos de criação; até 12 (`bindingsTotal` diz quantas há) |
| `composition` | `order` (fecho transitivo, dependências antes), `decisions`, `recommended`, `cycles`, `invalidDependencies` |
| `unavailable[]`, `relatedJobs[]`, `lexical.unmatched[]` | como na rodada 2 |
| `context` | com `--app`: leituras classificadas por kind (do mapa do módulo; `cache.answeredBy: module-index`), `signatures` dos elementos que a intenção nomeia (inputs, outputs, eventos com parâmetros, atributos, `jobReference`, `instanceSource`, papel), reuso, `continuation` (base + guard `--expectedSourceSha256`), `problems` |
| `continuation` | `omitted[]`: por match direto, as partes que a resposta composta não traz por desenho (`evidence` sempre; `example` quando é fragmento; `contract` quando um trecho foi reduzido) com o `--expand` exato |
| `coverage` | (fase 2) a cobertura da faixa: capacidades próprias, capacidades partilhadas projetadas para a faixa (`data.static`, `data.structure` e, desde a fase 3, `data.entity`: entidades de servidor, atributos — a chave estrangeira é o atributo com tipo `<Entidade> Identifier` —, tipo identificador, índices, atributos de índice), nota de que nada é herdado da outra faixa |
| `matches[].focus` / `evidenceRule` | (fase 2, fechamento de 23/09, só capacidades partilhadas) `focus.roles` = papel(is) do elemento que a intenção nomeia (o papel filho — registo, atributo, valor, atributo de índice — vence o contentor; `atributo` sozinho deixa os dois papéis de atributo; `identificador`/`FK` nomeia o tipo identificador), `focus.ops` = operações nomeadas por ordem de prioridade (fase 3: palavras de criação — criar, novo, adicionar — escolhem `create`); sem papel, `focus.options` lista os papéis com tipo e endereço e a nota; `evidenceRule` = a regra em uma frase (prova por papel/faixa; execução ≠ integridade; observado ≠ aplicabilidade; não declarado = indeterminado) |
| `matches[].operationsOmitted` | (fase 3) sob orçamento, as operações que a intenção NÃO nomeou saem do match por nome (esta lista) antes de qualquer corte às operações em foco; `--expand <id>:operations` devolve todas |
| `matches[].operations` / `native` / `differences` | (fase 2, fechamento) por operação: `route`, `preconditions`, `summary` (`coverage` complete/partial/none, listas `proven`, `conditional`, `refused`, `historical`, `declaredNotProven`, `undetermined`, `notStated`, e `text`) e `roles.<papel>` (papéis em foco primeiro): `native` (tipo qualificado do papel nesta faixa), `status` declarado (applicable / conditional / not-applicable / undetermined), `evidence` (proven-current / proven-historical / declared-not-proven / refusal-proven / refusal-declared / undetermined), `level` (C-executed-current / C-executed-historical / C-suite / declared / refusal-proven / undetermined), `verifiedQualified` (yes / "no (no executed result names <verbo> on <tipo>)" / n/a), `scope` (o que a prova estabeleceu), `note`, `alternative` (numa recusa), `proofs[]` (job, nível, `verified: {verbs, via, ops[{i, verb, fact}]}` só para o tipo do papel, `mismatches`), `negative[]` (com os textos das recusas), `observed` (comportamento que correu mas cuja integridade não está verificada: `behaviour`, `integrity: not-verified`, `missing[]`, `caution`, `ran[]` com nível e factos, `note`), `otherLanes.<faixa>` (`status`, `note`, `observed`); `native[]`: papel, tipo qualificado, tipo pedido no job, endereço, `runtime` (A-runtime: propriedades graváveis e bases lidas do Studio instalado); `differences` por faixa. Sob orçamento (`size.truncated` → `matches.operations`) cada operação reduz-se a `{summary: <texto>, roles: {<papel>: {status, evidence, alternative?, observed?: {integrity, caution}}}}` |
| `size` | `bytes` (UTF-8, incluindo este campo), `budgetBytes`, `status` (fase 3: `within` = nada reduzido; `reduced` = reduzido e dentro do orçamento; `insufficient` = nem a resposta mínima cabe), `truncated[]` (seção reduzida + `recover` = o `--expand` exato). O orçamento é um limite duro: a resposta nunca o excede. Quando é `insufficient`, a resposta é um resultado explícito e compacto — os matches diretos por `id` com `focus` e o `expand` inteiro, `composition.order`, `size.minimalBytes` (o que a resposta mínima precisaria) e `hint` — e, abaixo do mínimo que a API aceita (4096), despe ainda a lista de etapas (`truncatedStages`), a identidade e a continuação até caber |
| `continuation.omitted[]` | partes por match direto que a resposta não traz (por desenho ou por orçamento), com o `--expand` exato; partes possíveis: `contract`, `example`, `evidence`, `operations`, `native`, `bindings` |
| `validation` | prova em fixture, entrega, publicação, gates |
| `outsystemsUi` | (04/10/2026) só em intenção de criar/montar telas: padrões do OutSystems UI da faixa e do tipo de app, por categoria (§1.3) |
| `steps` / `provenExample` / `values` | (05/10/2026) gramática de cada passo de lógica citado com a action provada que os usa, o job provado inteiro escolhido pelas palavras da intenção, e os valores fechados de uma propriedade citada (§1.4) |

### 1.2 Continuação em lote (`--expand`)

`--expand <pedido>[,<pedido>...]`, cada pedido: `<id>:<parte>[+<parte>]` com partes `contract`, `example`, `evidence`,
`bindings`, `all`; `contract:<ponteiro api --op>`; `element:<Kind:Nome|@chave>` (com `--app`); `native:<Interface>`.
A resposta traz `expansions` só com o que foi pedido, `problems` por pedido (id desconhecido, parte desconhecida,
`element` sem `--app`), e o mesmo orçamento em bytes com as reduções declaradas (exemplo cortado, provas além das duas
primeiras em `proofsOmitted`, bindings além de 8). `evidence` = provas com descrição, ops/tipos/propriedades, notas
(`_why`) e cobertura, jobs negativos, limites, orientação, alternativas.

Com `intent` (11/10/2026; a sessão FarmaVirtual de 10/10 mandou `expand`/`detail` com intenção em 11 de 22 discovers e
nada voltou): a resposta composta traz também `expansions` com as partes pedidas. Elas são o último corte do orçamento
(depois de a parte de modelo chegar ao mínimo) e a etapa F nunca as corta em silêncio: cada parte, na ordem pedida, vem
inteira enquanto cabe; senão vem no corte que a F fazia (exemplo com 4 ops, 2 provas, 8 bindings), nomeada em
`expansionsReduced` (`{expand, kept, why}`); senão vai para `expansionsOmitted` (`{expand, why}`).
`continuations.next` é a chamada exata que devolve inteiras as reduzidas e as omitidas, só com partes que o `expand`
aceita; pedido desconhecido ou parte inválida também aparece em `expansionsOmitted`, com o motivo. Com `packet:true`, as
partes pedidas são `next.expand` do pacote.

Orçamento abaixo do mínimo (11/10/2026; a mesma sessão teve 7 respostas `insufficient`): na entrada (`discoverAll`, isto
é, MCP e CLI) um `budgetBytes` abaixo da resposta mínima (com toda parte pedida inteira: o mínimo de antes da etapa F)
sobe até ela quando cabe no teto da resposta (38.912 = 40.960 menos a folga do moldador, `budgetCeiling` do `ssam.mjs`)
e a resposta diz `inputAdjusted: [{path:"/budgetBytes", from, to, rule:"raise-to-minimal"}]` e, no próprio `size`,
`budgetAdjusted: {from, to, rule}` (uma camada de entrada que escreva seu próprio `inputAdjusted` por cima não o apaga);
num pedido misto, o espaço das `tools` vem junto. Mínimo acima do teto: páginas. A primeira página leva o que cabe no teto
(a parte de modelo da intenção no mínimo, depois as partes pedidas inteiras, na ordem) e o orçamento sobe só até o
mínimo dessa página (`raise-to-page`; fica o do chamador quando ele já a comporta), nunca até o teto: subir ao teto dava
a folga à parte de modelo, não às partes pedidas. `continuations.pages` são as chamadas `expand` exatas do resto, uma por
página, cada uma empacotada para caber no teto (para chamá-las juntas); `continuations.next` pede todo o resto a partir
da próxima página, e a resposta dela é essa página com as continuações das seguintes: seguindo só `next` chega-se à
última (toda página traz `pages` até a última). Orçamento igual ao teto é o da primeira página, sem ajuste a declarar; uma
página que cabe no orçamento do chamador e leva as partes da página no teto, ou tantos bytes de partes, fica com ele.
Parte maior que uma página vem reduzida na sua própria página: o exemplo com as primeiras ops que cabem e `reference`
(`ssam_reference {kind:"example"}`) para o job inteiro, nomeado em `expansionsReduced` com essa chamada em `next`. Sem
`ceilingBytes`, `discover()` (motor, testes, reexecuções para o espaço das ferramentas) mantém o limite duro.

As seções que entram depois da parte de modelo (a seção OutSystems UI, §1.3, e os extras C07: `provenExample`, `steps`,
`values`) fazem parte da resposta mínima na entrada (11/10/2026, 3ª revisão: subir até o mínimo exato da parte de modelo
não deixava lugar nem para a nota de corte, e "criar tela de listagem de pedidos com tabela e filtro" a 9.000 subia para
17.321 sem `outsystemsUi` nem `provenExample`, sem nada em `size.truncated`). O piso delas (`sectionsFloor`): as contagens
da seção OutSystems UI com a sua nota, os `steps` na forma que `fitWithSteps` guarda como piso (inteiros quando cabem em
1/4 da resposta, senão com o exemplo por referência), o `provenExample` por referência, os `values` inteiros e a nota
`c07`. A subida mira o mínimo da parte de modelo mais esse piso, e a folga acima do mínimo vai para as seções, nunca para
a parte de modelo (`size.reserved.sections`). Um orçamento que comporta a parte de modelo mas deixaria uma seção sem
palavra fica com o chamador, a parte de modelo orçada com o piso a menos; se ela não cabe ali, o orçamento sobe pelo
piso, com a parte de modelo como o orçamento do chamador a deu. Na entrada nenhuma seção some sem estar na resposta ou
em `size.truncated`: quando as `tools` tiram o lugar até da nota, o orçamento sobe pelo piso (`raise-to-minimal`), sob o
teto. Um título operacional mais longo que o do catálogo reafirma o orçamento subido, sem deixar a resposta acima dele.

### 1.3 Catálogo OutSystems UI (`outsystemsUi`, 04/10/2026)

Uma intenção que cria ou monta telas (match direto de `ui.screen`, `ui.html-page`, `ui.screen-spec`, `ui.html-visual`,
`ui.block-instance`, `ui.form`, `ui.list`, `ui.dropdown-search`, `ui.traditional-screen`, ou palavra de tela: tela,
página, formulário, dashboard, layout, card, menu...) recebe a seção `outsystemsUi`: os padrões do OutSystems UI da
faixa por categoria (a UI flow da própria biblioteca), nome + uma linha. Renomear/apagar/mover sem verbo de criação,
lógica (`screen action`) e dados não recebem nada. Tipo de app: da captura (`app`; O11 com Web* = Traditional), senão
das palavras (tradicional, mobile, reactive), senão todos os da faixa agrupados por biblioteca: ODC `OutSystemsUI`
(Reactive e Mobile, a revisão referenciada pela fixture), O11 `OutSystemsUI` 2.28.1 (Reactive e Mobile) e
`OutSystemsUIWeb` 1.12.8 (Traditional). `expand:"osui:<Categoria>|osui:<Padrão>|osui:<appType>[/<Padrão>]"` devolve
descrição, inputs, eventos, placeholders, a op de instância e a referência (`IMobileBlock:`/`IWebBlock:`).

Orçamento: a seção entra DEPOIS da parte de modelo já orçada e nunca a altera (matches, contratos, exemplos,
bindings, operações, contexto): `lines` se couber, senão `names`; só metadados fora dos matches (`relatedJobs`,
`identity`, notas, `coverage.shared`) cedem lugar à lista compacta; depois `counts`; por fim só a nota em
`size.truncated` com o `expand`. Com `tools`, a seção sai antes e volta no espaço que sobra; uma operação sem match de
modelo não a recebe. Dados: `platforms/odc/facade/outsystems-ui/catalog.json`, gerado por `generate.mjs` (`--check`;
`--extract-odc` relê offline a fixture ODC) a partir de `kernel/catalog/ui/OutSystemsUI*.json`,
`kernel/docs/mapa/screen-osui-inventory.json` e das assinaturas OutSystemsUI da fixture ODC, com os sha256 das fontes.
Textos são os da biblioteca (cortados, nunca reescritos); sem descrição: `descriptionMissing`. Testes:
`tests/discover-osui.test.mjs`.

Pacote de 05/10/2026 (lane E, C07): a seção deixou de ser a primeira a sumir. Com intenção de tela, quando a parte de
modelo deixaria menos espaço que o piso (o nível `counts` mais a nota, se couber em 1/4 do orçamento), ela é orçada com
esse piso a menos e `size.reserved.outsystemsUi` diz quanto; senão a parte de modelo fica idêntica à de antes. A lista
aparece também com 8 KB; uma resposta `insufficient` ainda leva os `counts` quando cabem. Os
padrões que a intenção nomeia vão em `outsystemsUi.named` em todos os níveis, pelo nome do padrão ou por sinônimo do
catálogo (`synonyms` em `catalog.json`: deck e swipe → StackedCards; slider e range → RangeSlider; `osui:deck` também
resolve). A expansão de uma capacidade `ui.*` (`expand:"ui.list:example"`) também traz a seção, com o mesmo piso.

### 1.4 Gramática por passo, exemplo provado e valores (05/10/2026)

Três seções novas da resposta composta, todas tiradas do índice (contratos e jobs da faixa), sem fonte nova:
- `steps`: numa intenção de action (action, ação, lógica, fluxo, função) que cita passos (aggregate/consulta → `get`,
  if/condição → `if`, for each/percorrer → `foreach`, while, switch, assign, chamar → `call`, exceção → `raise`,
  retornar; salvar/atualizar/apagar só junto de "registro"): `grammar.<passo>` são as chaves que cada passo aceita
  (`logic.steps.<passo>` do contrato da faixa) e `example` é a action inteira do menor job da suíte da faixa que usa
  todos os passos citados, com `reference` (`ssam_reference {kind:"example", query:{id}}`) para o job inteiro.
- `provenExample`: entre as provas dos matches diretos, o job da suíte com mais palavras da intenção, inteiro até
  6 KB (senão `whole:false` e o `reference`). Ex.: "criar timer que roda a cada hora" no O11 traz
  `pacote-laneE-timer-schedule` com `set Schedule "Every 60 minutes"`.
- `values`: valores fechados de uma propriedade citada, por faixa: `InputType` (os nove valores e o `type` do fragmento
  html), `Schedule` O11 em texto (`Every 60 minutes`, `Every day at 00:00`, `Every Monday at 00:05`) e `CronSchedule`
  ODC (cinco campos).
Orçamento: as três seções entram DEPOIS da parte de modelo, das `tools` e da seção OutSystems UI, no espaço que sobra,
e nunca as alteram: `provenExample` inteiro → 6 primeiras ops → só `job` e `reference`; depois `steps.example` → só o
`reference`; depois a gramática e os valores; o que não coube é citado uma vez em `size.truncated` (seção `c07`). A
resposta mínima (`insufficient`) nunca passa do orçamento: depois das etapas de corte, corta a lista de matches do fim
(`matchesOmitted`), as recusas declaradas e, no limite, fica só `{ok, size}`.

Nenhuma rota, capacidade ou fragmento manda provar antes de entregar: a entrega valida e recusa antes de mudar; prova
headless (`ssam_job`) só quando a pessoa pede. Dropdown, instância de bloco (inputs `:Nome`, eventos `@Evento`,
`<slot>`) e listas aninhadas trazem na rota a forma de fragmento que o op html já compila. Testes:
`tests/pacote-laneE-discover.test.mjs`.

### 1.5 Pacote de trabalho (`packet:true`, 10/10/2026)

O SSAM não controla como cada cliente abre e instrui seus agentes. Agente sem brief relê docs e o módulo (medido:
1.428 leituras repetidas de docs; 29 a 82 leituras por agente antes de escrever). Por isso o brief vem do SSAM, numa
chamada que qualquer agente faz: `ssam_discover {intent, lane, app, packet:true}` (CLI `ssam discover ... --packet`).
As instruções do servidor, a descrição da ferramenta e o `AGENTS.md` dizem: agente ou subagente começa por ela.

Resposta `ssam-packet/1` (`platforms/odc/facade/work-packet.mjs`), seções nesta ordem:
- `module`: do resumo do módulo (`ssam-digest/1`, `moduleDigest` em `module-map.mjs`), os elementos que a intenção
  nomeia: entidades, estáticas (10 primeiros registros), estruturas e a assinatura das actions. Nome escrito inteiro
  (`Order_Create`) traz também o corpo da action, logo depois dela, e os vizinhos (o que ela chama, quem a chama, os
  tipos da assinatura). Intenção de tela traz a tela nomeada. Nada nomeado: o panorama, na ordem do resumo. Sem `app`:
  só uma nota.
- `capabilities`: os matches diretos com operação, fatias do contrato, dependências, o que a faixa não tem e a gramática
  dos passos citados. Elemento nomeado inteiro no módulo traz antes a capacidade do tipo dele (action de servidor:
  `logic.server-action` e `logic.flow`).
- `example`: o exemplo provado (`provenExample`, escolhido de novo com essas capacidades), senão o do primeiro match.
- `rules`: até 16 regras do time (`docs/CONHECIMENTO-DO-TIME.md`) e do OutSystems padrões, escolhidas por tópico
  (categorias dos matches fortes, palavras da intenção; tópico raro pesa mais) e por palavra de técnica (json, visible,
  lambda...). Lição "O11:" só no O11; AR1 só no O11. Nunca o texto inteiro.
- `next`: entregar com `o11_deliver`/`studio_deliver`; corrigir com `patch` + `basedOn`; as operações roteadas, por nome.

Tamanho: até 38.912 bytes (o teto da resposta menos a folga do moldador); um `budgetBytes` menor vale. Cada seção tem
uma parte da sala (`SHARES`); o que ela não usa passa para a seguinte, na ordem. Dentro da seção ficam os itens mais
relevantes; o resto sai e é nomeado em `cuts`, com a chamada que o devolve. Mesma entrada, mesmos bytes: o pacote não
traz tempo, cache nem data. Testes: `tests/pacote-trabalho.test.mjs`.

## 2. Arquitetura e o que foi reutilizado

Nenhuma assinatura vive na descoberta. O índice é construído das fontes verificáveis e reutilizado por identidade:

| Fonte | Nível | Como entra | Identidade |
|---|---|---|---|
| `anvil-odc api --op verbs\|spec\|logic\|screen\|html\|html-visual` | B | seis chamadas puras ao CLI da faixa na construção do índice | sha256 do CLI e do `Anvil.Core.Odc.dll` |
| `kernel/tests/jobs-odc/*.json` (67) e `jobs-odc-negative/*.json` (7) | C-suite | nome, sha256, descrição, ops/tipos/propriedades/passos, `expectedMessages`, notas `_why`, **bindings** (regras de ligação extraídas das ops) | listagem com tamanho e mtime |
| `kernel/.local/lane-odc/test-work/<job>.result.json` | C-executed-* | `accepted`, `isValid`, `coverage.porTipo`, carimbo `provenance` (§2.3) | idem |
| `anvil-odc verify-catalog` + assemblies do Studio | identidade nativa | plataforma, `ideVersion`, definições Verify; hash de cada assembly nomeado pelos carimbos, sob demanda | listagem do runtime na chave; hashes no índice |
| `platforms/odc/docs/model-api/*.json` | A | só em `native:<Interface>`/`--type` | listagem na chave; sha no índice |
| `kernel/docs/NAO-DA.md` | orientação com origem | cabeçalhos, tipo, `Visto em:`, veredicto | sha |
| Mapa do módulo (`ssam map` / `ssam_map`, `platforms/odc/facade/module-map.mjs`) | D | só com `--app`: as leituras por `kind`, do índice persistente da captura (falta: o leitor da faixa o constrói); um mapa que não responde cai no leitor | `sourceSha256` |
| Leitor existente (`odc inspect` / `studio_inspect`) | D | só com `--app`; `text`/`select`/`path` com `expectedSourceSha256` | `sourceSha256` |
| `platforms/odc/facade/discovery-capabilities.json` | orientação curada | palavras-chave, sinônimos, rota, ponteiros, provas, dependências (`unless`), recomendações, alternativas, limites com origem, kinds de contexto, `example.ops` | sha do descritor |

### 2.1 O contrato dos verbos: quatro coisas distintas

| Camada | O que é | Onde | Como se verifica |
|---|---|---|---|
| **Forma aceita pelo validador** | por verbo: chaves obrigatórias (alternativas com `\|`), chaves opcionais, kind write/read; `_*` sempre aceitas | `VerbSurface.Verbs`; imposta por `VerbSurface.Check` em `ModelSession.ApplyOne` antes de qualquer handler; projetada por `api --op verbs` | `SurfaceTests.VerbContractIsEnforcedBeforeDispatch` (recusas com mensagem exata); `EveryJobOpOfEverySuitePassesTheVerbContract` (10.000+ ops das suítes) |
| **Comportamento implementado pelo handler** | as chaves que cada handler lê de `op` | `Verbs.cs`, `HtmlDelta.cs`, `HtmlVisual.cs` | `SurfaceTests.HandlerKeyReadsMatchTheVerbTable` (rodada 3): varredura das fontes por handler; chave lida e não declarada (inalcançável) ou declarada e não lida (aceita e ignorada) falha pelo nome. Estado em 22/09: correspondência exata em 18 verbos; única exceção documentada, `create` lê `replace` só para o recusar com uma dica |
| **Comportamento coberto por testes** | quais chaves e propriedades os jobs exercitam de fato | `CoverageLedger` dos resultados (`coverage.porTipo`: tipo × verbo × propriedade) e a varredura estática das suítes | `proofs`/`evidence` na resposta; `identity.jobs` |
| **Orientação semântica curada** | frases `effect`, gramática de referências, `summary`/`limits`/`guidance` do descritor | `VerbSurface.References`, descritor | não imposta; rotulada como orientação com origem |

Compatibilidade (mudança de comportamento de execução introduzida na rodada 2, a considerar antes da liberação): um job
com verbo desconhecido, chave obrigatória ausente ou chave fora da tabela passa a ser **recusado antes de tocar o
modelo**, com a tabela na mensagem. Varredura de compatibilidade (rodada 3, só leitura): 348 arquivos de job / 21.830 ops
no checkout operacional (`C:\Users\andre\SSAM-Hybrid`, excluindo `.local`, `lab`, `journal`) e os mesmos no worktree —
**0 ops recusáveis**. Jobs privados fora do repositório devem ser provados na fixture antes de confiar; anotações vão em
chaves `_*`. A dica específica de `create` + `replace` ("use replace:true dentro de um logic spec") deixou de ser
alcançável: a recusa genérica `unknown key(s) 'replace'` chega primeiro.

### 2.2 Identidade do índice, cache e limites de detecção

Chave: versão do esquema, faixa, sha do construtor, sha do descritor, sha do CLI e do DLL do kernel, listagem
(nome/tamanho/mtime) do diretório do Studio, tamanho/mtime da fixture e do sidecar, listagem do índice nativo, dos jobs,
negativos e resultados, sha do NAO-DA. Consultas quentes não fazem hash de arquivos grandes; os hashes de conteúdo
(DLLs nomeados pelos carimbos, fixture, bases declaradas) são calculados na construção e gravados no índice.
**Limite:** um arquivo substituído por outro de mesmo tamanho e mtime não é percebido até `--rebuild`.

### 2.3 Proveniência: o que "provado na combinação atual" garante

Carimbo (`anvil-job-provenance/2`, escrito por `OdcJobTests`): `jobSha256`; `base` declarada, `baseKind`
(`fixture`|`job`) e `baseSha256` (fixture hasheada pela mesma política de resolução do runner); `fixtureSha256` da
fixture da faixa; `kernelSha256`; `platform`, `ideVersion`, `studioDirectory`; `nativeAssemblies` = nome e sha256 de
**cada assembly carregado do diretório do Studio no processo que executou o job**.

Classificação (`classifyExecutions`): `C-executed-current` exige resultado aceito **e** igualdade, componente a
componente, de job, fixture, kernel, versão do Studio, todos os assemblies carimbados (hash do arquivo presente hoje) e
da base: fixture com o mesmo hash, ou job-base cujo próprio resultado seja atual (cadeia seguida com detecção de ciclo).
Qualquer valor indeterminado do lado atual, ausente no carimbo ou diferente mantém o resultado em `C-executed-historical`
com a razão em `mismatches` (ex.: `ideVersion: current value undetermined`, `nativeAssemblies: absent from the stamp`,
`base job 'screen-form' is not current (...)`). Carimbos da rodada 2 (sem `nativeAssemblies`/`base`) ficam históricos.

Alcance declarado: a garantia cobre o texto do job, a cadeia de bases dentro da suíte, a fixture da faixa, o DLL do
kernel e os assemblies do Studio efetivamente carregados. **Não cobre**: produtores (o kernel ODC não importa
referências headless), o ambiente além desses arquivos, e a faixa O11 (sem carimbo).

Acoplamento observado (22/09): `kernelSha256` só coincide quando o CLI (`.local/lane-odc/cli/Anvil.Core.Odc.dll`) e o
host da suíte saem da **mesma** compilação; uma recompilação de um dos lados, mesmo sem alteração de fonte, produziu
um DLL com hash diferente, e a descoberta passou corretamente a `historical` com `kernelSha256: result … vs current …`
até o CLI ser recompilado a partir do mesmo `obj`. Procedimento: compilar o CLI e correr a suíte na mesma sessão de
build (nesta ordem ou na inversa, sem compilações intermédias).

Studio da faixa O11 (W3, 10/10/2026): `laneSources('o11')` usava por padrão a cópia antiga
`Service Studio 11 - Anvil 4516` (11.55.87), e a suíte carimba com o Studio instalado (11.55.91): tudo saía histórico.
Agora a pasta vem de `o11StudioDir` (`discovery.mjs`), primeira que tem `ServiceStudio.Framework.dll`: a conexão
registrada (`readConnection`, como `laneEnvironment`), `ANVIL_STUDIO_DIR`, a instalação do registro (Uninstall
"OutSystems Service Studio 11"), `%ProgramFiles%` e, por último, a cópia antiga. Todo processo do CLI da descoberta
(`api`, `verify-catalog`, `api --op native`) roda com `sources.env`: a mesma pasta em `ANVIL_STUDIO_DIR` (no ODC,
`ANVIL_ODC_STUDIO_DIR`). A proveniência não mudou: os carimbos são comparados como antes, com a pasta que o CLI carrega.
`studioSource` diz de onde ela veio. Testes: `tests/discover-studio.test.mjs`.

### 2.4 Contexto da aplicação, busca, composição, orçamento

Como na rodada 2 (leituras classificadas, `CAPTURE_CHANGED`, assinaturas em lote, dependências condicionais com
`existingInCapture`, busca lexical, fecho transitivo determinístico). Orçamento em bytes UTF-8, limite duro, com
reduções por etapas nesta ordem (fase 3), cada uma declarada com o `--expand` exato: (A) texto derivado ou duplicado —
notas dos matches, `relatedJobs`, `evidenceRule` uma vez, identidade compacta, notas de envelope; (B) contexto da
captura — reuso (4 por termo), elementos por kind (8), assinaturas (3); (C) camadas inferiores — alternativas a uma
linha, dependências ao que as torna executáveis; (D) o que a intenção não pediu, nos matches diretos — bindings (6),
**operações não nomeadas (saem por nome, `operationsOmitted`; as nomeadas ficam inteiras)**, **exemplos (3 ops, as
dos verbos em foco primeiro)**, limites (1), contratos (chaves + `expand`), resumos (220), depois bindings/exemplos/
contratos inteiros, alternativas removidas por completo; (E) o que nunca se perde — as operações em foco reduzem-se a
`summary` + `status/evidence/alternative/observed` por papel, o envelope perde `routes/lexical/coverage.note`, e o
match direto fica só com `id`, `via`, `level`, `focus`, `operations` compactas e `expand`; (F, 11/10/2026) por último
as expansões pedidas por nome (exemplo 4 ops, 2 provas, 8 bindings), só numa resposta de `expand` sem intenção do motor:
ao lado de uma intenção, e na entrada, elas não passam pela F (vêm inteiras, reduzidas e nomeadas, ou omitidas e
nomeadas, §1.2). Se mesmo assim não cabe, a resposta é o resultado
`insufficient` (§1.1, `size`); na entrada (`discoverAll`), o orçamento sobe até o mínimo ou a resposta pagina (§1.2). Uma resposta
composta sem `--app` cabe no padrão sem perder contratos nem exemplos (teste); a 12.000 bytes uma intenção de dados
mantém o foco, o estatuto e a evidência por papel, a cautela de integridade e a continuação exata (teste).

Palavras que os casadores leem (11/10/2026; 1º discover da sessão FarmaVirtual de 10/10): caminhos, URLs e nomes de
arquivo da intenção (`C:\...`, `/home/...`, `./src/x.css`, `\\srv\...`, `https://...`, `index.html`, `*.css`, um
caminho entre aspas com espaços) deixam pastas, host e nome do arquivo fora das palavras que `query`, o exemplo provado,
os passos, os valores e a seção OutSystems UI leem (`withoutPaths`); fica o que o trecho diz do seu tipo, entre pausas:
o arquivo vira a palavra da extensão (`prototipo.html` → html, `Chart.js` → js, `clientes.json` → json), a URL vira o
esquema (`https`, com a extensão em que termina) e a pasta vira só a pausa. A resposta repete a intenção como escrita.
Nomes com barra ou ponto (`StyleSheet/WebStyleSheet`, `ui.html-page`, `Client.FvModal`) ficam. E uma palavra de família
é dita também pela palavra da intenção para ela: a tradução (`tema` → theme) ou a palavra que dá nome à capacidade,
quando é palavra-chave dela e canônico do grupo de sinônimos da palavra da família (`CSS` de `ui.theme-css`). Assim
"tema" e "CSS" nomeiam o tema de `ui.theme-css`, que deixa de ser rebaixada a alternativa; as outras palavras do grupo
`css` (estilo, style, classe, stylesheet) não nomeiam, porque dizem também o estilo ou a classe de um atributo, de uma
entidade ou de um widget ("criar entidade Aluno com atributo Classe"). Só contam as palavras escritas, nunca o canônico
que elas produziram.

`tools` (entrada única) cabe em volta da parte de modelo, nunca o contrário: o `discover()` já orçou a parte de modelo
como acima. Quando a intenção é só operação (os matches que houver são palavras de passagem), os itens vão inteiros
e, se não couberem, o `discover()` roda uma vez com orçamento menor; quando há as duas partes, os itens reduzem-se
primeiro (inteiro → `{tool, verb, lane, args, why}` → `{tool, verb, lane}`, declarado em `size.truncated` como
`tools`). Em último caso fica só o envelope com os ids dos matches diretos e as ferramentas. `size.budgetBytes` é o do
chamador, salvo quando a parte de modelo de um pedido misto subiu até o mínimo (ou até a primeira página): então é esse
mínimo mais o espaço das `tools`; ou quando as `tools` deixam a seção OutSystems UI ou os extras C07 sem lugar nem para a
nota: então sobe pelo piso deles (§1.2). Os dois ditos em `inputAdjusted` e em `size.budgetAdjusted`. Uma intenção sem rota de ferramenta nunca passa por aqui: sua resposta é byte a byte a de antes.

Faixa O11 (desde o piloto da fase 2, 23/09/2026 — `docs/PILOTO-FASE2.md`): `--lane o11` responde **só para o recorte
partilhado** (static entities, registos, estruturas, atributos de estrutura). As duas capacidades vivem uma vez em
`discovery-capabilities-shared.json` (identidade, palavras-chave, rota, ponteiros de contrato, operações e
pré-condições) e são projetadas por faixa na construção do índice: provas, jobs negativos, limites, kinds de
contexto, tipos nativos qualificados e o estatuto de cada operação daquela faixa. `discovery-capabilities-o11.json`
traz só as rotas da faixa; nada do descritor ODC é herdado — uma intenção fora do recorte devolve `matches: []` e o
`coverage` da faixa. O índice O11 lê os resultados carimbados que a suíte O11 (`JobTests`) deixa em
`kernel/.local/test-work` para os jobs de `tests/provenance-o11.json`, a identidade do Service Studio pelo novo
`anvil verify-catalog`, e os contratos nativos de cada tipo pelo `api --op native --type` (runtime instalado, não o
catálogo). Cada resposta de uma capacidade partilhada traz `focus` (papel e operação nomeados pela intenção),
`operations` (por operação: rota, pré-condições, resumo da cobertura da família e uma declaração POR PAPEL do
elemento — estatuto, evidência calculada só sobre o tipo nativo desse papel nesta faixa, escopo da prova, recusas,
comportamento observado com integridade não comprovada, estatuto na outra faixa), `native` (tipos qualificados por
papel com o contrato lido no runtime) e `differences` (por faixa); `--expand <id>:operations+native` devolve-os
inteiros. Uma prova de um papel nunca conta para outro (o replace de um registo não prova o da entidade), uma prova
de uma faixa nunca conta para a outra, e um resultado histórico nunca se apresenta como atual. O leitor de capturas
O11 (`--app`) passa pelo `kernel-reading.mjs` da faixa; as leituras por kind de `--app`, nas duas faixas, vêm do
mapa do módulo (`module-map.mjs`, o índice persistente da captura), e texto e assinaturas continuam no leitor.

### 2.5 Por que a rodada 2 precisou de seis a oito chamadas (diagnóstico)

Fontes: journals e respostas gravadas pelos agentes da rodada 2 (`docs/evidence/descoberta-2026-09-22/eval/work/`) e
os registros do launcher; os transcripts desses quatro agentes ficaram vazios e são declarados ausentes.

| Consulta (caso 1 · B / caso 2 · B) | Motivo | Faltante / repetida | Correção geral |
|---|---|---|---|
| 1 composta com `--app` (42 KB) | ponto de partida | `contracts` reduzidos a chaves pelo orçamento, sem exemplos, dependências só brevíssimas | contratos inteiros dos matches diretos, excertos de exemplo, `bindings`, `continuation.omitted` com o `--expand` exato |
| releituras dos arquivos gravados (2 / 3) | respostas maiores do que o agente lia inline | repetidas | orçamento explícito por resposta |
| `--detail` ×5 / ×2 (11–61 KB cada) | ver o contrato inteiro e um exemplo de ops | contrato faltava inteiro na composta; **12–35 KB de provas** por detail (notas, cobertura, expectedMessages de todos os jobs) que ninguém pediu | `--expand <id>:contract+example` seletivo, evidência só a pedido, orçamento também nos detalhes |
| exemplo de `logic.aggregate` sem `IJoin` → leitura de `aggregate-full.json` e `data-entity.json` | ligação lista↔aggregate | exemplo vinha do job errado (`logic-steps`) | exemplo escolhido pelo job mais representativo; bindings `set <IList> Source = <Aggregate>.List`, `set <IListItem>/OnClick Destination = IMobileScreen:<name>`, `create IAliasedSource args.dataSource = IServerEntity:<name>` |
| `inspect` recusados (1 / 8) | instrução do laboratório citava `--oml`, inválido | falha de laboratório | comandos validados antes da rodada 3; `element:` no `--expand` |
| recusas de `base` (4 / 3) + leituras de `JobSources.cs`/AGENTS §0.2 | job fora do repositório não resolvia `tests/fixtures/...` | falha de laboratório; único acesso a internals de B | `JobSources.KernelRoot` |
| `inspect` de entidades/telas/consumidores | compreender a aplicação e a regra (quais consumidores) | necessários nas duas condições | `--app` lista kinds e assinaturas |

Leitura: nenhuma chamada foi caprichosa — a composta não trazia o que `--detail` trazia, e `--detail` trazia 4–30× mais
do que o pedido; 40–60 % dos bytes lidos por B eram releituras e provas não pedidas; o tempo não medido dos journals
não pode ser atribuído (sem transcripts).

## 3. Matriz de cobertura (faixa ODC)

Inalterada em cobertura funcional desde a rodada 2 (44 capacidades e 8 ausências no descritor — as rodadas anteriores
escreveram "45" por erro de contagem, corrigido no inventário da fase 1; ver a tabela da rodada 2 no histórico
do arquivo); níveis `C-exec-current` dependem da suíte ODC ter corrido com o carimbo v2 nesta máquina (§5).

## 4. Limitações

- Recorte: 44 capacidades (contagem do descritor; inventário de cobertura em `docs/COBERTURA-DESCOBERTA-FASE1.md`);
  intenções fora dele devolvem `matches: []` e `lexical.unmatched`.
- Provas C são headless; recibos de merge/publicação não entram no índice.
- Índice nativo (A) em 1.7.24 contra Studio 1.7.25 instalado: a resposta avisa.
- Exemplos são excertos do job de prova mais representativo (primeiro job da capacidade em que os verbos pedidos são
  ≥ 30% das ops); um excerto é sempre `fragment`; `--expand <id>:example` devolve o conjunto inteiro (até `example.max`).
- Bindings são padrões extraídos de ops (`set` em propriedades de ligação, `Value` de argumentos de eventos, `link`,
  `args` de `create`), não semântica verificada além do próprio job aceito.
- Busca lexical; seleção de assinaturas por nome; detecção de identidade por tamanho/mtime para arquivos grandes.

## 5. Validação executada (checkout isolado; baseline = fim da rodada 2)

| Verificação | Baseline (rodada 2) | Final (rodada 3) |
|---|---|---|
| Correspondência handler ↔ tabela | não testada | `HandlerKeyReadsMatchTheVerbTable`: 18 verbos, 0 divergências (1 exceção documentada) |
| Base de jobs fora do repositório | recusada (`JobSources.FixturePath` exigia raiz acima do job) | `KernelRoot()` como fallback; `FixturesResolveForJobsOutsideTheRepository` (2 casos); smoke real pelo `ssam job` (aceito, 18 s) |
| Testes O11 focados (SurfaceTests + JobSourceTests) | 11 | **27/27** |
| Suíte ODC (carimbo v2) | 100/100 (carimbo v1) | **100/100 em 12m19s** (`test-odc-r3.log`, carimbo com nomes de assembly) e **100/100 em 12m22s** (`test-odc-r3b.log`, carimbo com caminhos relativos ao Studio, 79 assemblies por job); 67/67 classificados `C-executed-current` depois de o CLI ser recompilado a partir da mesma compilação (§2.3) |
| Exemplos de comandos publicados (§1 e AGENTS.md) | — | os nove comandos executados no checkout isolado pelos launchers `ssam.cmd`/`odc.cmd` (0,3–2,5 s, índice reutilizado), todos `ok:true` |
| Descoberta (`discovery.test.mjs`) | 17 | **16/16** reescritos: classificação estrita (14 razões de divergência, cadeia de bases, ciclo), bindings, `--expand` (partes, ponteiros, elemento, nativo, erros por nome), orçamento com contratos/exemplos preservados, composta real com contratos inteiros e bindings, leitor real + `element:` |
| Varredura de compatibilidade | — | 0 ops recusáveis em 348 jobs / 21.830 ops (operacional e worktree) |
| Oráculo nativo da avaliação | — | validado antes das tentativas contra os jobs aceitos da rodada 2: 11/11 e 8/8 checks |
| Sinônimos `sort`/`join` (defeito lexical visto na avaliação) | — | acrescentados depois da avaliação; a intenção do caso 1 passa a casar `logic.aggregate` (não medido) |

## 6. Liberação: procedimento de integração e ativação (a executar por decisão do usuário; nada foi ativado)

**Versão candidata**: branch `claude/contextual-discovery`, commits `938a8a7` (rodada 1), `dce129f` + `b82ec49`
(rodada 2), `f119f3d` + `c83dc1e` + commit de fechamento (rodada 3). **Não aplicar** `eb7b788` (cópia do estado
operacional anterior). Dependências: as já presentes na raiz operacional (.NET SDK 10.0.401, Node v24, ODC Studio
1.7.25 instalado); nenhum pacote npm novo (`package.json` inalterado); nenhum novo serviço.

**Mudanças de compatibilidade a considerar**

| Mudança | Efeito | Como confirmar antes |
|---|---|---|
| `VerbSurface.Check` em `ModelSession.ApplyOne` (Anvil.Core, partilhado ODC/O11) | uma op com verbo desconhecido, chave obrigatória ausente ou chave fora da tabela é recusada antes de tocar o modelo; anotações vão em `_*` | varredura só de leitura de todos os jobs privados com `docs/evidence/descoberta-2026-09-22-r3/eval/compat-scan.mjs <raiz> kernel/src/Anvil.Core/Kernel/VerbSurface.cs` (0 ops recusáveis em 21.830 na raiz operacional em 22/09) |
| `JobSources.FixturePath` com `KernelRoot()` | um job fora do repositório resolve `tests/fixtures/...` contra o kernel em execução (antes: recusa); jobs dentro do repositório inalterados; caminhos absolutos fora das fixtures continuam recusados | `JobSourceTests` (2 casos novos); smoke com um job fora do repositório |
| Carimbo `anvil-job-provenance/2` | resultados com carimbo anterior ficam `historical` até a suíte ODC correr; `kernelSha256` só bate se CLI e suíte saírem da mesma compilação (§2.3) | correr a suíte ODC na janela; `identity.jobs.current` na resposta |
| Descoberta `ssam-discovery/3` | forma da resposta mudou (`examples`, `bindings`, `continuation`, `expansions`, `size.truncated[].recover`); `--detail` passou a ser uma expansão orçamentada; MCP `ssam_discover` ganhou `expand` e orçamento padrão 40960 | não há consumidores programáticos além dos testes; conexões MCP abertas conservam a versão antiga até reconectar |
| Descoberta `ssam-discovery/4` + descritor partilhado `ssam-discovery-capabilities-shared/2` (fechamento da fase 2, 23/09) | `matches[].operations` passou de um resumo por operação a `summary` + `roles.<papel>` (§1.1); `focus`/`evidenceRule` novos; `examples[].scope`; redução por orçamento com outra forma; o esquema 1 do descritor partilhado é recusado na construção do índice | só capacidades partilhadas (`data.static`, `data.structure`); as 42 capacidades ODC próprias não mudam de forma; `docs/PILOTO-FASE2.md` §5.1 traz o antes/depois |

**Fase 1 — integrar e compilar isolado (sem janela, sem tocar componentes em uso)**

1. Aplicar os commits acima na branch operacional; conferir `git status` limpo e `git diff` restrito aos arquivos das
   rodadas (kernel: `VerbSurface.cs`, `Verbs.cs`, `CommandSurface.cs`, `JobSources.cs`, `SurfaceTests.cs`,
   `JobSourceTests.cs`, `OdcJobTests.cs`; fachada: `discovery.mjs`, `discovery-capabilities.json`, `mcp.mjs`,
   `odc.mjs`, `ssam.mjs`, `launch.mjs`, testes; docs; evidências).
2. Compilar o CLI ODC num diretório **versionado**, sem sobrepor o em uso:
   `dotnet build kernel/src/Anvil.Cli.Odc -c Release -o kernel/.local/lane-odc/cli-<commit>` e, na mesma sessão de
   build, os testes O11 focados (`dotnet test kernel/tests/Anvil.Tests -c Release --filter
   "FullyQualifiedName~SurfaceTests|FullyQualifiedName~JobSourceTests"`, ~20 s, sem worker).
3. Verificar o candidato sem o ativar: `dotnet kernel/.local/lane-odc/cli-<commit>/anvil-odc.dll api --op verbs` devolve a
   tabela; a suíte ODC (`dotnet test kernel/tests/Anvil.Tests.Odc -c Release`, ~12 min, in-process, não usa o worker)
   passa 100/100 — ela recompila `Anvil.Core.Odc.dll` no seu próprio `bin`; para que os carimbos batam com o CLI, o CLI
   deve ser copiado dessa mesma compilação (`kernel/tests/Anvil.Tests.Odc/bin/Release/net8.0/Anvil.Core.Odc.dll`
   tem de ter o mesmo sha do `cli-<commit>/Anvil.Core.Odc.dll`; senão recompilar o CLI logo após a suíte).
   Nota: a descoberta (`discovery.mjs`) lê o CLI em `kernel/.local/lane-odc/cli` (fixo); até à troca, `discover`
   responde com o CLI antigo, sem `api --op verbs`, e a validação do descritor falha — é esperado.

**Fase 2 — janela de ativação (só quando o usuário decidir; o worker ODC mantém os DLLs de `cli/` carregados)**

1. Guardar o diretório em uso: copiar `kernel/.local/lane-odc/cli` para `kernel/.local/lane-odc/cli-prev-<data>`.
2. Parar o worker ODC pelo procedimento habitual do usuário (não é passo automático deste documento), copiar
   `cli-<commit>` sobre `cli`, reiniciar o worker pelo procedimento habitual.
3. Correr a suíte ODC na mesma sessão de build do CLI (ou recompilar o CLI a seguir) para carimbar os resultados.
4. Smoke nas entradas públicas: `.\ssam discover "form" --lane odc` (`identity.jobs.current` = 67, `warnings` só a
   nota do índice nativo), `.\ssam discover --expand ui.form:contract+example`, `.\ssam discover "<intenção>" --app
   <captura própria .oml>` (`context.status` e `size.truncated`), `.\ssam job --lane odc <um job já conhecido>`
   (aceito), e numa conexão MCP nova `ssam_discover {intent:"form"}` e `{expand:"ui.form:contract"}`.

**Critérios de sucesso**: os quatro smokes respondem `ok:true`; nenhum job operacional conhecido é recusado pelo
contrato; suíte ODC 100/100 com 67/67 atuais; sessões MCP existentes continuam a funcionar até reconectar.

**Rollback**: restaurar `cli-prev-<data>` sobre `cli` numa nova janela (mesmo procedimento de parar/reiniciar o
worker); `git revert` dos commits da fachada devolve a descoberta à rodada anterior ou a remove; os resultados
carimbados v2 são dados válidos e não precisam de reversão; nenhuma migração de estado, release ou seleção de pacote
foi tocada.

## 7. Avaliação de eficiência (rodada 3)

Protocolo congelado antes das tentativas (`docs/evidence/descoberta-2026-09-22-r3/eval/PROTOCOL-r3.md`, `FREEZE.json`
com o commit `f119f3d` e os hashes do CLI, do kernel, da fixture, dos documentos, do oráculo). Quatro sessões novas
(agentes independentes, duas por vez, sem suíte concorrente, sem coaching), os mesmos dois casos da rodada 2; condição
A = docs do commit `eb7b788` sem `discover`; B = docs desta rodada com `discover` e `--expand`. Medição a partir dos
transcripts (`measure-transcripts.mjs`: cada `tool_use` é uma chamada, o `tool_result` dá bytes UTF-8 e duração;
não atribuído = parede − ferramentas = tempo de modelo entre um resultado e a chamada seguinte). Oráculo nativo
(`oracle-r3.mjs`): reexecução do job pelo launcher + leitura do módulo produzido.

Tempos: **até aceito** = primeira execução com `accepted=True`; **até correto** = execução aceita do arquivo entregue
(o oráculo correu depois, sobre esse arquivo); **duração** = último − primeiro registro do transcript; **ferramentas**
= união dos intervalos das chamadas (chamadas sobrepostas contam uma vez); **não atribuído** = duração − ferramentas,
sem causa atribuída (os registros não distinguem geração do modelo, latência do harness ou leitura).

| Sessão | Correto (oráculo) | Descoberta: chamadas (KB) | Docs lidos (KB) | Jobs antigos (KB) | Internals | Total apresentado | Jobs (infra / contrato) | Até aceito | Até correto | Duração | Ferramentas | Não atribuído |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| caso 1 · A | 11/11 | 0 | 6 (145) | 7 (31) | 0 | 224 KB | 1 (0/0) | 2,7 min | 2,7 | 3,8 | 0,8 | 3,0 |
| caso 1 · B | 11/11 | 3 (130): composta `--app`, `--expand`, composta extra p/ join | 7 (78) | 2 (11) | 0 | 232 KB | 1 (0/0) | 2,9 | 2,9 | 3,9 | 0,9 | 2,9 |
| caso 2 · A | 8/8 | 0 | 8 (116) | 4 (35) | 1 | 224 KB | 2 (0/0), ambos aceitos | 1,8 | 3,1 | 4,0 | 0,9 | 3,0 |
| caso 2 · B | 8/8 | 2 (65): composta `--app`, `--expand` | 4 (38) | 3 (20) | 0 | 161 KB | 2 (0/0), ambos aceitos | 2,3 | 3,4 | 4,4 | 1,3 | 3,1 |

Rodada 2 · B, mesmas tarefas (journals auto-reportados, transcripts ausentes): 8 e 6 chamadas, 385 e 542 KB, 5,1 e
5,3 min até o 1.º aceito, 4 e 3 recusas de base.

Conclusão (quatro sessões, uma por caso e condição; indicação, não generalização): **a descoberta reduziu as suas
próprias consultas em relação à rodada anterior (2–3 chamadas, 65–130 KB, zero internals, contra 6–8 chamadas e
385–542 KB) e preservou a correção; a comparação com o fluxo sem descoberta não demonstrou redução do tempo até o
candidato correto** (2,9 / 3,4 min em B contra 2,7 / 3,1 em A; duração 3,9 / 4,4 contra 3,8 / 4,0; bytes 232 / 161 KB
contra 224 / 224). Parte da melhora entre rodadas vem das correções de laboratório (base, comandos), que também
beneficiaram A. O tempo não atribuído (2,9–3,1 min, igual nas duas condições) não tem causa medida. Meta "1 composta
+ ≤ 1 expand": cumprida no caso 2; no caso 1 uma composta extra pelo *join*. Detalhe e limitações:
`docs/evidence/descoberta-2026-09-22-r3/eval/RESULTS-r3.md`.

### 7.1 Versão avaliada e versão final

`FREEZE.json` (escrito em 2026-09-23T00:14:36Z, antes do primeiro registro dos agentes, 00:15:23Z) fixa a versão
avaliada: commit `f119f3d`, CLI `8e41de20…`, `Anvil.Core.Odc.dll` `bec10d93…`, `discovery.mjs` `5b0792f5…`, descritor
`1f47f808…` (sem sinônimos sort/join), documentos B de `f119f3d`, Studio 1.7.25.10762. Depois da avaliação: sinônimos
`sort`/`join` (defeito lexical do caso 1), documentação, `PROVAS.md`, evidências, carimbo com caminhos relativos
(`OdcJobTests`), reexecução da suíte ODC (100/100, 12m22s) e recompilação do CLI a partir da mesma compilação
(`Anvil.Core.Odc.dll` agora `3af2775f…`, CLI `9fd03f58…`; fontes idênticas; `discovery.mjs` inalterado, hash conferido).
Testes das mudanças posteriores: `discovery.test.mjs` 17/17 com o teste focado
`the list-with-sort-and-join intent reaches logic.aggregate…` (verifica o defeito lexical, não mede tempo); suíte ODC
100/100 com 67/67 atuais. A versão final não foi avaliada; nenhum ganho lhe é atribuído.

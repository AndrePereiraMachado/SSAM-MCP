# Catálogo abrangente — contrato de contribuição `ssam-catalog-contribution/1`

Versão do contrato: `ssam-catalog-contribution/1` (M0, 23/09/2026). Dono: integrador. Mudanças passam pelo registro de
decisões do controle; as frentes não editam este arquivo.

As frentes A (dados e lógica), B (interface) e C (referências, integrações, diagnóstico e operação) contribuem **fragmentos**
que o motor existente compõe com `discovery-capabilities-shared.json` (esquema `ssam-discovery-capabilities-shared/2`) num
**único índice**, o mesmo que `ssam discover` / `odc discover` / MCP `ssam_discover` já servem (resposta `ssam-discovery/4`).
Não há catálogo paralelo, nem esquema por plataforma: o que é comum vive uma vez; o que difere vive em `platforms.<faixa>`,
`elements[].platforms.<faixa>` e `operations.<op>.roles.<papel>.<faixa>`. Contrato da resposta e das regras de evidência:
`docs/DESCOBERTA-CONTEXTUAL.md` (§1.1, §2.3, §2.4). Código: `catalog.mjs` (composição, propriedade, verificação pura),
`discovery.mjs` (`buildIndex`: projeção por faixa e validação contra CLI, suítes e runtime).

## 1. Arquivos

| Caminho | Escritor | Conteúdo |
|---|---|---|
| `catalog/fragments/<A\|B\|C>/<tema>.json` | a frente do diretório | fragmentos (§2); nome em kebab-case pelo tema, não por versão |
| `catalog/ownership.json` | integrador (gerado) | dono de cada tipo do inventário fixado, de cada capacidade/ausência legada e de cada ferramenta operacional (§5) |
| `catalog/README.md`, `catalog.mjs`, `catalog-check.mjs`, `discovery*.{mjs,json}` | integrador | contrato, motor, descritores base |
| `catalog/tools.json` | integrador | rotas de ferramenta da entrada única (`ssam-tool-routes/1`, §7); fora da composição do catálogo |

Um fragmento pode ter várias capacidades; prefira um arquivo por família coerente (ex.: `A/logic-assign.json`,
`B/widgets-input.json`, `C/rest-consume.json`). A composição é determinística: frentes em ordem A, B, C; arquivos em
ordem alfabética.

## 2. Fragmento (`ssam-discovery-fragment/1`)

```json
{
  "schemaVersion": "ssam-discovery-fragment/1",
  "contract": "ssam-catalog-contribution/1",
  "front": "A",
  "title": "o que este fragmento cobre",
  "reviewedAt": "AAAA-MM-DD",
  "synonyms": { "<canônico>": ["<variante>", "..."] },
  "capabilities": [ ... ],
  "unavailable": [ ... ],
  "coverage": [ ... ]
}
```

`front` tem de ser igual ao diretório. `synonyms` são unidos aos existentes (mesma chave: união das variantes); cada
variante é uma string não vazia.

## 3. Capacidade (forma shared/2)

Campos, como em `discovery-capabilities-shared.json`:

- `id` (único em todo o catálogo composto). Prefixos por frente: A `data.` `logic.` `refactor.`; B `ui.`; C `integration.`
  `reference.` `module.` `process.` `security.` `event.` `timer.` `ai.` `deliver.` `read.` `ops.` `diagnostic.`.
  Exceção: reutilizar o id de uma entrada legada **da própria frente** listando-o em `supersedes`.
- `category`, `title`, `keywords` (lista não vazia), `summary`, `route` (`kind` obrigatório: `job`, `reader`, `data`,
  `delivery`, `feature`...; `operation` = a entrada pública exata), `contract` (ponteiros para `api --op`
  `verbs|spec|logic|screen|html|html-visual`, ex. `verbs.verbs.create`, `logic.steps.node`), `guidance`, `example`
  (`{ops, max}`), `depends` (`id` ou `{id, unless}`), `recommends` (`{id, when}`), `alternatives` (`{id, when}`).
- `keywords`: cada entrada é uma string (sentido de sempre) ou uma **palavra-chave ancorada** (§3.1).
- `lanes` (opcional, padrão `["odc","o11"]`): restringe a capacidade a uma faixa quando não há equivalente justificado.
- `elements[]`: um por PAPEL do elemento (`role`, `child` para papel filho, `runtime: "kernel"` só para tipos sintetizados
  pelo kernel). Por faixa: `platforms.<faixa>.native` = tipo **qualificado** (`namespace.Nome`, conferido contra o runtime
  por `api --op native` no build), `jobType` (nome usado nos jobs) e `address` (gramática de endereçamento).
- `operations.<op>` com `op` em `read usages create set rename replace move duplicate delete` (outra operação só com
  `verbs` em cada declaração): `route`, `preconditions[]` e `roles.<papel>.<faixa>` = `{status, proofs[], negative[],
  scope, note, alternative, verbs?, props?, observed?}`.
  - `status`: `applicable` (exige job positivo da faixa em `proofs`), `conditional` (exige prova ou negativo),
    `not-applicable` (exige negativo ou `note`, e `alternative` quando existir), `undetermined` (sem `proofs`).
  - `observed` = correu e foi lido, integridade não verificada: `{behaviour, integrity: "not-verified", missing[],
    caution, proofs[]}`. Nunca é aplicabilidade nem recomendação.
  - Papel não declarado numa operação = indeterminado. Prova de um papel não conta para outro; prova de uma faixa não conta
    para a outra; resultado histórico nunca aparece como atual (o motor calcula `proven-current`/`proven-historical`/
    `declared-not-proven` pelo carimbo `anvil-job-provenance/2` e pelo ledger qualificado).
- `platforms.<faixa>`: `proofs[]`, `negative[]` (nomes de jobs das suítes da faixa: ODC `kernel/tests/jobs-odc`,
  `jobs-odc-negative`; O11 `kernel/tests/jobs`, `jobs-negative`; um `negative` — aqui e nas declarações por papel —
  é sempre um job de recusa que declara `expectError`, o único tipo que o índice lê; os jobs de `jobs-negative` do O11
  cuja expectativa vive num teste C# ou em `expectValid: false` entram como `limits` com `origin`), `context` (`{kinds, signatures}` do leitor),
  `limits[]` (`{text, origin}`), `differences[]`.
- Campos só do catálogo (não chegam ao índice nem à resposta):
  - `requires[]` = `{id, provider: A|B|C|integrator, why}`: pré-requisito de outra frente **ainda não entregue**. Não use
    `depends` para um id inexistente (o build recusa). Quando o id passar a existir, `catalog-check` avisa para movê-lo
    para `depends`/`recommends`.
  - `supersedes[]`: ids legados que esta capacidade substitui — capacidade/ausência própria de faixa
    (`discovery-capabilities.json`) ou capacidade do descritor partilhado (`data.static`, `data.structure`, `data.entity`).
    Só o dono (`ownership.json` → `legacy`) pode fazê-lo, cobrindo as faixas do legado. Na composição a entrada antiga
    sai dessas faixas e referências a ela passam a apontar para o novo id. O integrador remove fisicamente o legado ao
    integrar.

Referências resolvem **por faixa** da capacidade (como o build, que valida faixa a faixa): uma entrada de `depends`,
`recommends` ou `alternatives` pode levar `lanes` (`{"id": "logic.server-action", "lanes": ["odc"]}`) quando só vale
nessas faixas; fora delas a projeção a descarta. Referências cruzadas usam só ids de capacidade (e `role` quando for
um papel). A UI remete à capacidade da action; não
copia o contrato de outra frente. Ciclos em `depends` são reportados pela composição (`composition.cycles`).

### 3.1 Palavra-chave ancorada (pedido A-006)

Uma palavra genérica ("variáveis", "ramo falso", "excluir a action", "mensagem de erro") só nomeia o elemento de uma
frente no contexto dele; como string, ela seleciona a capacidade em qualquer intenção que a diga (set 2 da frente A:
15–16 seleções indevidas de B/C por faixa). A entrada ancorada diz esse contexto:

```json
{ "form": "variaveis", "with": ["tipo", "tipadas", "zerar", "server action"], "without": ["ambiente", "variaveis de cliente"] }
```

- `form` (obrigatório): a forma, uma ou mais palavras, lida como uma string de `keywords` (uma palavra: termo da
  intenção; várias: na ordem das palavras da intenção, como toda palavra-chave de várias palavras).
- `with` (opcional): a forma só conta quando a intenção diz **pelo menos um** destes termos.
- `without` (opcional): a forma não conta quando a intenção diz **qualquer** destes termos.
- Pelo menos um de `with`/`without`; quando presente, cada um é uma lista não vazia (`null` não é lista); termos não
  vazios. Sem outros campos.
- Um termo é dito como uma palavra-chave é lida:
  - **uma** palavra: pela palavra da intenção que, tokenizada (acentos, stopwords, radical), lhe corresponde por `fold`
    ("types" diz "type", "tipos" diz "tipo"). Uma **variante** de um grupo de sinônimos não é dita pelo canônico nem
    pelas outras variantes do grupo ("tipo" não é dito por "types", "api" não por "json", "database" não por
    "entidade", "botao" não por "navegar"): escreva as duas grafias quando quiser as duas. Assim a leitura não depende
    dos grupos da faixa.
  - um termo que **é um canônico** (`rest`, `entity`, `navigate`, `form`, `block`, `screen`, `action`...) é dito por
    qualquer variante do seu grupo **na faixa**, como uma palavra-chave de uma palavra ("json", "consumir",
    "integracao" dizem `rest` no ODC). Os grupos diferem por faixa: o `catalog-check` lista em `info` as variantes de
    cada termo canônico, por faixa. Para excluir só a palavra, use variantes literais (`api`, `endpoint`), não o canônico.
  - palavra **derivada** (-ção, -mente, -ing, -ed): dita só por uma palavra derivada da intenção, como uma variante de
    sinônimo (pedido C-010): `configuracao` não é dito por "configura", nem `publicacao` por "publica".
  - **várias** palavras: na ordem das palavras da intenção, como uma palavra-chave de várias palavras; nunca vale pelo
    canônico do grupo de que é variante (mais largo: "variaveis de cliente" e "variaveis de tipos diferentes" produzem
    os dois `variable`).
- Sem o contexto a forma não pontua nem aparece em `why`, e uma forma de **uma** palavra governa a palavra sozinha na
  capacidade inteira: fora do contexto a palavra também não pontua no título (+2) nem no resumo (+1) da capacidade,
  salvo se uma string de uma palavra da capacidade tiver a palavra ou se uma palavra-chave da capacidade que contou na
  intenção a contiver ("screen preparation" dito: "preparation" não está sozinha). Uma forma de várias palavras não
  cala as suas palavras no título. Com o contexto pontua como a string (+4 várias palavras, +3 uma) e aparece em `why` como
  `"<forma> [<o que a intenção disse>]"`, em tokens: a palavra da intenção (`"variavei [tipo]"`; `"variabl [typ]"` para
  "types"), o canônico que a variante dita produziu (`"... [rest]"` para "json") ou a frase. Essa palavra conta como
  coberta (fora de `unmatched`) e entra nos nomes procurados na aplicação, como toda palavra de `why`. Uma entrada só
  com `without` aparece só com a forma. O esquema da resposta não muda.
- Uma entrada ancorada que conta com uma palavra de **elemento** nomeia a família da sua capacidade (a capacidade não é
  rebaixada como família nomeada só por palavra genérica quando a intenção nomeia outra família: "variáveis" nunca dá a
  palavra de família `variable`); não nomeia a família de nenhuma outra capacidade. Uma forma de uma palavra que nomeia
  **operação** — a palavra de operação ou uma variante de uma palavra do seu grupo (`excluir`/`apagar` de `delete`,
  `substituir` de `replace`) — é acerto de operação em qualquer língua, como `delete`: não seleciona sozinha uma família
  e não nomeia família.
- Dono da palavra (regra de A-005): uma forma ancorada de uma palavra reivindica a palavra para a sua capacidade **só
  nas intenções em que o contexto vale**, como a string faria ("widget" deixa então de valer por `block` no
  "block event" de outra capacidade); fora do contexto não reivindica nada. Entradas de `unavailable` não reivindicam.
- A mesma forma vale em `unavailable[].keywords` (§4).
- `synonyms` continuam só strings não vazias (o `catalog-check` e o build recusam outra coisa): um canônico vale para
  todas as capacidades e para o foco, então contexto de uma capacidade vai na palavra-chave dela, não no grupo.
- Recusas, no `catalog-check` e no build (mesma tokenização): forma ou termo que fica sem palavra (stopword como `uso`,
  `no`, `de`; palavra de uma letra; `c#`); termo `without` que a própria forma diz (`"excluir a action"` sem `action`);
  o mesmo termo em `with` e em `without`. Essas entradas nunca contariam.
- Escolha dos termos: `with` = palavras do próprio elemento/contexto (a action/o fluxo para lógica; usos, chamadores,
  impacto para refatoração; tipo/zerar para variáveis tipadas); `without` = os homônimos das outras frentes em palavras
  literais (widget, formulario, botao/button, api, endpoint, banco externo, processo/BPT, pipeline,
  ambiente/configuracao, debugger), conferindo no `info` quais são canônicos. Termo ambíguo não serve de exclusão
  (`input` também é o `input parameter` da lógica).
- Uma forma ancorada que repete uma string da mesma capacidade conta duas vezes, como duas strings iguais contam hoje:
  sobe a pontuação da capacidade e a barra de 34% das outras.
- Prova: uma forma copiada de uma frase de teste mede só essa frase (set 2). Meça a forma com paráfrases que não a
  escreveram e com sondas de outras frentes que digam a palavra genérica no contexto delas (tela, widget, REST, BPT,
  operação).

## 4. Ausência declarada (`unavailable[]`)

`{id, lanes?, keywords[], reason, evidence, negative: {<faixa>: [jobs]}, alternative, supersedes?}`. Recusa declarada
não é recusa executada: sem job negativo, `evidence` diz a origem e a resposta a trata como declarada. `keywords` aceita
strings e entradas ancoradas (§3.1).

## 5. Contabilidade (`coverage[]`) e propriedade

Denominador: o inventário reconciliado com os runtimes instalados
`docs/evidence/catalogo-abrangente/inventario-reconciliado/inventory.json` (sha256 em `ownership.json`; ODC Studio
1.7.25.10778, O11 11.55.87), ODC 564 e O11 408 tipos qualificados, mais 35 ferramentas operacionais. O inventário da fase 1
(ODC 556, metadados 1.7.24) é histórico; a diferença está em `inventario-reconciliado/reconciliation.json`. Chave: `<faixa>:<namespace>.<Nome>`
(ex. `odc:OutSystems.Model.Logic.Nodes.IAssignNode`) ou `tool:<nome>`. Cada chave tem um dono; só o dono escreve a
entrada de contabilidade do tipo. Regras de atribuição (família do inventário + exceções nomeadas; assinaturas seguem o
domínio do elemento assinado) estão em `ownership.json.rules`. Reatribuição = pedido de decisão ao integrador.

Estados por tipo e faixa:

- `represented` (automático): um papel de capacidade composta tem esse tipo como `native` nessa faixa (qualquer frente;
  se não for o dono, `catalog-check` avisa para coordenar).
- Entrada de contabilidade do dono: `{type, status, applicability, classification?, reason?, origin?, alternative?,
  operations?: {<op>: {status, note?}}, capability?, role?, note?}`:
  - `status`: `excluded` (não é elemento de autoria neste contexto: assinatura no consumidor, gerado, base, não aplicável
    na faixa — exige `reason` e `origin`), `gap` (aplicável, sem rota pública — exige `reason` e `origin`), `undetermined`
    (exige `reason`: o que falta saber), `represented` (explícito, com `capability` e `role` existentes).
  - `applicability`: `applicable | conditional | not-applicable | undetermined`.
  - `classification` só quando difere da classe do inventário (`concrete | base | signature | generated | undetermined`),
    com `origin`.
  - `origin`: job, `arquivo:linha`, ponteiro `api --op`, documento ou regra do inventário. Metadado de Delete/Name/Create
    não é prova de operação pública.
- `unaccounted`: nenhum dos anteriores. Conclusão exige zero `unaccounted` por frente, faixa e classe, sem percentual global.
- Classe `outside-object-root` (interfaces sem raiz `IObject`/`IObjectSignature`: aplicações/módulos referenciados,
  extensões, merge, metamodelo, nós de expressão): mesmas regras de entrada (`classification: outside-root` quando
  preciso), contadas em `accounting[].outsideRoot`, separadas dos elementos do modelo.
- Ferramenta `tool:<nome>`: `represented` com a `capability` que carrega o seu contrato (sem `role`), ou
  `excluded`/`gap`/`undetermined` com motivo.

## 6. Validação

| Nível | Comando (na raiz do próprio checkout) | O que prova |
|---|---|---|
| T0 puro | `node platforms/odc/facade/catalog-check.mjs --front <A\|B\|C>` | esquema, ids, prefixos, cada palavra-chave (string ou ancorada, com a tokenização do build: forma/termo sem palavra, entrada que nunca conta, §3.1; `info` lista os termos que são canônicos e as suas variantes por faixa), sinônimos só strings, `supersedes`, referências e `requires`, papéis/estados/regras de evidência, jobs existentes, chaves e dono da contabilidade, ponteiros e nativos contra o último índice construído no checkout (quando existe); contabilidade por faixa/dono/classe. Saída JSON; código 1 com erro |
| T0 lista | `node platforms/odc/facade/catalog-check.mjs --front <X> --list unaccounted\|represented\|classified` | a lista de trabalho da frente |
| T0 real | `.\ssam discover "<intenção>" --lane odc --rebuild` e `--lane o11` | o build do índice recusa qualquer ponteiro, job, dependência ou tipo nativo que não resolva na CLI/suíte/runtime da faixa, e repete as recusas de palavra-chave e de sinônimo do T0 sobre os sinônimos compostos da faixa |
| T1 | `node --test platforms/odc/facade/tests/catalog-<a\|b\|c>-*.test.mjs` | testes da frente (seleção, foco, orçamento, expansão) pela entrada pública ou por `discover()` |
| T1 mecanismo | `node --test platforms/odc/facade/tests/discovery-catalog.test.mjs` | composição, recusas do contrato, contabilidade e build real com fragmentos-sonda (integrador) |

`catalog-check` não inicia CLI, Studio, leitor, worker nem rede. `ssam discover` sem `--app` chama só a CLI do checkout
(`api --op`, `verify-catalog`, `api --op native`) e grava o índice em `platforms/odc/.local/discovery/<faixa>/`.

## 7. Rotas de ferramenta (`catalog/tools.json`)

O `ssam_discover` responde qualquer pedido do SSAM. Para uma operação (abrir módulo, publicar, dados, Service Center,
Portal...), `tool-routing.mjs` acrescenta `tools` à resposta. As rotas vivem só neste arquivo; o `composeCatalog` não o
lê e nada dele entra no índice de capacidades.

- Uma entrada por ferramenta viva e um verbo por valor do parâmetro que escolhe a operação (`verbParam`; `selector`
  `enum`, `documented`, `presence` ou `example` para operações públicas comuns de `odc_read`/`odc_write`).
- Cada rota: `when`, `args` (modelo com `<placeholder>`), `preconditions`, `next`, `triggers` (conjunções de 1 a 4
  termos), `without` (veto), `slots`, `intents` pt/en (oráculo do teste, nunca gatilho) e `equivalent` na outra faixa.
- Vocabulário próprio em `synonyms` (chaves com `@`, nunca formas do texto), `compounds`, `laneWords`, `fillers`.
  Nunca copie paráfrases para as palavras-chave das capacidades: é este arquivo que roteia ferramentas.
- `nonVerbEnums` declara todo enum que não escolhe operação (filtro, autenticação, argumento).
- Regras gerais do casador (sem frases copiadas): vetos e gatilhos valem no pedido inteiro e em cada oração
  (`e`/`and`/`depois`/`,`); um Nome depois de um substantivo de `nameNouns` ("entidade Status", "app Portal") não é
  palavra do pedido; um erro de digitação por palavra é corrigido contra o vocabulário deste arquivo quando a correção
  é única; `clauseStartOnly` limita formas ambíguas ao início da oração ("publica o módulo" × "API pública"); `solo`
  responde um pedido de uma palavra só ("status", "dados", "logs", "timers"); `modelGuard` veta as rotas operacionais
  quando um elemento de modelo que a rota não cita vem com verbo de construção, verbo de mudança ("apagar a tela X do
  módulo") ou widget de UI; quando um verbo de construção ou mudança tem por objeto um elemento de modelo ("criar um
  timer que limpa os logs"); sob condição ou evento (`quando`, "ao salvar", "a cada login", clique num widget) com
  elemento, clique ou escrita; ou com um conceito que só existe dentro do app (`modelOnly`: usuário atual, paginação,
  ordenação). Um gatilho com verbo de construção ou mudança só vale quando o objeto do verbo é um dos substantivos do
  gatilho (`objects`: "criar uma aplicação com um módulo" cria o app). Leitores (`reader: true`) nunca respondem um
  pedido que começa por construir, mudar ou gravar algo que não citam. `@substantivo#nome` casa o substantivo seguido de
  um Nome ("processo BPT AprovarPedido": um elemento, não a lista); um nome de op depois de `opNouns` ("a op
  add-attribute") não é verbo do pedido; `argsIf` preenche um argumento pelo que o pedido diz ("LifeTime" →
  `surface: "lifetime"`). O fallback para a outra faixa responde com o `equivalent` da faixa pedida quando ele existe e,
  sem ele, só para um grupo sem ferramenta na faixa pedida (cada `gap` declara `group`); `operationalCapabilities`
  lista as capacidades que nunca tornam o pedido "duas partes".
- `explains` (ferramenta, somado ao do verbo): palavras que a rota toma como argumento ou contexto seu — a action, o
  nó, a tela e a variável que o depurador aponta, o usuário logado do invoke, o "sem disparar nada" do watch. A regra de
  modelo não as lê como mudança de modelo e o `modelGuard` não as lê como conceito só do app; um elemento de modelo
  entre elas ainda veta a rota ao lado de um verbo de construção. Numa oração própria ("..., sem disparar nada") elas
  valem só se a oração não trouxer vocabulário de modelo que a rota não explica.
- `byLane` (rota das duas faixas): `args`, `when`, `preconditions` e `next` de uma faixa quando diferem (o `run` O11 do
  depurador é só a entrada nativa restrita); a outra faixa fica com os da rota. O teste de modelos confere esses `args`
  contra o schema vivo como os da rota.
- Textos de duas chamadas das rotas destrutivas (CX15 r3, CT-8): nunca escritos à mão. O arquivo guarda o marcador
  `{{destructive.twoCalls}}` (O11 e `studio_data_delete`) ou `{{destructive.twoCalls.odc}}` (ODC: a execução leva o
  `operationId` da prévia como `operationUuid`) e `compileToolRoutes` o troca, ao carregar, pelo texto de
  `destructive-operations.mjs` (`DESTRUCTIVE_SUFFIX`: as duas chamadas, a resposta do dono com o número E os nomes,
  `WORDS_RULE` e `AFTER_INTERRUPTION`, com SC_LOCAL_FAILURE; mais `ODC_EXECUTION_UUID`), por
  `destructive-catalog-texts.mjs`. Marcador desconhecido é problema do catálogo. A resposta do `ssam_discover` nunca corta
  um texto gerado (o nível `full` corta os outros em 160/120 caracteres). São 29 lugares (22 `next` + 7 pré-condições);
  `destructive-r3-txt-catalog.test.mjs` os lista e confere o arquivo, o catálogo carregado e a resposta.
- O nó de fluxo: `normalize()` tira o acento e "nó" viraria "no" (stopword). O lexer lê a palavra crua antes: "nó" é o
  token `node` (`@node`), e "nós" também depois de artigo, contração ou quantificador ("os nós da action"), nunca o
  pronome ("nós precisamos publicar").
- Vocabulário por conceito, nunca por frase: um sinônimo novo entra numa chave com sinônimos reais ("estágio" em
  `@stage`, "carregar" em `@abrir`, "ocupado/travado" em `@ocupado`), não como literal copiado de um pedido de teste.
- Teste: `node --test platforms/odc/facade/tests/tool-routes.test.mjs` compara com o `tools/list` vivo (falta, sobra,
  enum sem classe, comandos documentados e modos por presença nos dois sentidos — todo campo marcado "Alone:" ou
  "Instead of job" no schema vivo é rota ou está em `nonVerbModes` —, argumento fora do schema, segredo fora de
  `<placeholder>`, texto de shell) e roda o oráculo. `discover-tools.test.mjs` mede os pedidos de avaliação, os pedidos
  dos verificadores (top-3 por rota), o silêncio nas mudanças de modelo, as regras gerais e de conceito, a dica e a
  regressão; `discover-tool-debug-ptbr.json` guarda os pedidos naturais em pt-BR do depurador (top-1 pelo
  `discoverAll`, regra de modelo incluída), nunca copiados para este arquivo.

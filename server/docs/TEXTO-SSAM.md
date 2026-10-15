# Texto do SSAM: o que está ligado no MCP

Junção das etapas do plano "Texto do SSAM" (`C:\Users\andre\SSAM-analises\html-do-ssam\PLANO.md`), feita em 11/10/2026 na
branch `feat/texto-ssam`, sobre a base `45a849b0` (`feat/prototipo-nativo`). Nada foi feito ao vivo: sem Studio, sem MCP
`ssam`, sem tenant e sem push.

Entraram as sete etapas das lanes e a B2:

| Etapa | O que é | Branch da lane |
|---|---|---|
| C1 | ida de tela: `ssam_map view:"html"` lê a tela ou o bloco como `ssam-html/1` | `feat/tx-c2` (contém a C1) |
| C2 | volta de tela: a op `html` na forma edição `{screen, basedOn, edit}` | `feat/tx-c2` |
| B1 | criar tela: a op `html` na forma documento (`<screen>`/`<block>`) | `feat/tx-b1` |
| DL1 | ida de dados: `ssam_map view:"ddl"` (`ssam-ddl/1`) | `feat/tx-dl` |
| DL2 | volta de dados: a op `spec` com `data.ddl` | `feat/tx-dl` |
| LG1 | ida de lógica: `ssam_map view:"flow"` (`ssam-flow/1`) | `feat/tx-lg` |
| LG2 | volta de lógica: a op `logic` com `data.flow` | `feat/tx-lg` |
| B2 | rotas do `ssam_discover` para os três textos | esta junção |

Cada texto tem sua documentação: `docs/SSAM-HTML.md` (telas), `docs/LEITURA-RAPIDA.md` (dados, seções "Texto de dados" e
"Volta do texto de dados") e `docs/TEXTO-LOGICA.md` (lógica).

Em 12/10/2026 uma segunda junção (branch `feat/texto-ssam-2`, seção 8) tirou os três limites que tinham ficado: o texto
escrito sobre uma leitura antiga é juntado em 3 vias com o que mudou no Studio (lógica e dados), o mapeamento de registro
campo a campo do O11 é lido e escrito pelo texto, e screen action, action de bloco e data action nascem do texto de
lógica com o dono no cabeçalho. A revisão dessa junção (seção 9) fechou os casos em que o texto juntado, ou escrito sem a
leitura, ainda perdia o que o Studio fez.

## 0. O nome agora é `ssam_code` (12/10/2026)

Decisão do dono: o "Texto do SSAM" vira a ferramenta MCP **`ssam_code`**. Ela lê e escreve o módulo como código, nas duas
faixas (O11 e ODC). A mesma palavra serve para ler e para escrever.

| `part` | O que é | Forma | Antes (continua valendo) |
|---|---|---|---|
| `ddl` | entidades, estáticas com registros, estruturas, índices, settings/site properties, variáveis, timers | SQL DDL, `ssam-ddl/1` | `ssam_map view:"ddl"`; op `spec` + `data.ddl` |
| `logic` | actions (servidor, cliente, tela, data action) | pseudocódigo, `ssam-flow/1` | `ssam_map view:"flow"`; op `logic` + `data.flow` |
| `html` | telas e blocos | HTML, `ssam-html/1` | `ssam_map view:"html"`; op `html` |

No DDL, `index`, eventos e registros de amostra podem vir antes ou depois da entidade que nomeiam. O dono também pode
ser uma entidade já existente no módulo: `create index ByName on Category (Name);` dispensa repetir a declaração de
`Category`. Se o nome não existir no texto nem no módulo, a compilação recusa com `DDL_OWNER_UNKNOWN` e sugere nomes
próximos. Um statement com `@key` continua exigindo sua leitura em `basedOn`.

Três ações:

- `grammar {part?}`: a sintaxe e um exemplo do zero. Não precisa de módulo. É o começo num módulo vazio.
  - ddl: entidade com FK e índice único, estática com registros, estrutura, `Decimal(18,2)`, Boolean com default,
    Date Time com `CurrDateTime()`.
  - logic: server action com aggregate, if, assign, raise e saída; e a screen action da tela.
  - html: tela com lista, variável e botão que chama a screen action.
  - Sem `part`: os três cartões e dois exemplos de uma escrita só.
    - `example`: módulo vazio ou de serviço (`_CS`), sem UI flow. Dados e server action (`ops` cria a exceção).
    - `exampleWithUi`: módulo com UI flow Reactive ou Mobile. Dados, tela e screen action (`ops` cria a exceção e o role).
  - Tela, bloco e screen action precisam de UI flow. Num módulo vazio ou `_CS`, a recusa é `PREFLIGHT_REFUSED`.
- `read {target, part, element?, page?, offset?}`: é o `ssam_map` da view da parte. As continuações já vêm como `ssam_code`.
  Módulo vazio devolve documento vazio (`empty:true`) e aponta o `grammar`. Não é erro. A lista de actions pagina por
  `offset`/`max`.
- `write {module, part, text?, edits?, basedOn?, element?, also?, ops?, removes?}`: monta a op que o kernel já aceita e entrega pela
  ferramenta de entrega da faixa, registrada no servidor (`o11_deliver`, `studio_deliver`).
  - Mesmo caminho: journal, travas, palavras de autorização, uma recusa com todos os problemas e patches conferidos,
    regras do dono. Não existe segundo caminho de entrega.
  - O que mandar: no `ddl`, só as instruções que mudam. Com `text` na `logic`, cada action mudada INTEIRA, como foi lida, com a
    mudança. Linha que falta é apagada. Texto com lacuna nos ids (`@n`, `@p`, `@l`) é recusado antes da entrega, salvo
    `removes:true` (ou a lista dos ids). No `html`, só os elementos mudados, cada um inteiro com o seu `k`.
  - Para mudar linhas de uma action existente nas duas faixas, use `ssam_code {lane, action:"write", module,
    part:"logic", element:"X", basedOn:"<textSha>", edits:[{replace:"@n4", with:"..."}]}` no lugar do texto inteiro.
    `basedOn` é o `textSha` da leitura guardada; `text` e `edits` são alternativas. Outras actions entram em
    `also:[{part:"logic", element, basedOn, edits}]`. A fachada recompõe o texto para a mesma entrega de lógica:
    - R1 — endereço: `@n3`, `@p1` ou `@l2` escolhe a linha cujo último token é o id próprio; linhas `->`, SQL `|`
      e `///` não possuem esse id. O cabeçalho usa sua `@key`; id repetido exige a ocorrência (`@n10#2`). Texto sem
      `@` inicial deve corresponder, com `trim()`, a uma única linha da leitura.
    - R2 — indentação: `with`/`insert` aceita string com quebras de linha ou lista de linhas; CRLF vira LF. Se a
      primeira linha começa na coluna zero, todo o trecho recebe a indentação da linha endereçada; senão é preservado.
    - R3 — `replace` com `with` troca a linha e conserva seu id se a primeira linha nova não tem id próprio.
      Se alguma linha nova é mais funda que a primeira, troca também o bloco; senão o bloco existente continua depois.
    - R4 — `delete` remove a linha, seu bloco e as linhas `///` imediatamente acima com a mesma indentação;
      não apaga o cabeçalho da action.
    - R5 — `after` com `insert` mais fundo entra como primeiro filho; senão entra depois do bloco. `before`
      entra antes das linhas `///` da linha. Inserts no mesmo ponto conservam a ordem recebida.
    - R6 — todas as edições endereçam a leitura original. Uma única recusa reúne todos os problemas de todas as
      partes, com `at` e as linhas envolvidas: endereço ausente, desconhecido ou ambíguo, chave inválida, combinação
      inválida, conteúdo vazio, faixas sobrepostas, ids duplicados novos e saltos/comentários com destino removido.
      Os ids próprios que somem viram `removes`; uma leitura antiga guardada continua válida para o merge de 3 vias.
  - A resposta da entrega traz `removed`: o que a escrita apagou (nós de action, elementos de tela). Nada some calado.
  - `also` põe outras partes na mesma entrega. Uma screen action nova (`action <Tela>.X`, sem `@key`) vai antes da edição
    da tela e depois de um documento `<screen>` novo. O `ssam_code` faz essa ordem sozinho.
  - `onclick="X()"` vira `onclick="X"` (a edição recusava os parênteses).
  - ODC: `owners` padrão = a tela editada (`element`), a tela de cada screen action e os nomes do código.
  - SQL Server (`CREATE TABLE`, `INT PRIMARY KEY`, `VARCHAR`, maiúsculas) é recusado antes da entrega, com a forma certa.
    As recusas de sintaxe do kernel (`DDL_*`, `FLOW_*`, `HTML_*`) ganham `continuations.grammar` e falam `ssam_code read`.
  - Correção de recusa: `patch` + `basedOn {job, sha256}`, como nas entregas. No ODC, `owners` e `changes` saem do job
    recusado quando não vêm na chamada.
  - `publish:true` com as palavras do usuário em `authorize` publica depois de um merge limpo.

Os nomes antigos viram apelidos, nada quebra:

- `ssam_map view:"logic"` é `view:"flow"`.
- Op de job `ddl` é `spec` com `data.ddl` (aceita `data.text`).
- Op `logic` aceita `data.text` como `data.flow`.
- `ssam_reference` responde o cartão do `ssam_code` para `api {op:"ddl"|"flow"|"ssam-html"|"code"}` e para `example` ou
  `recipe` com texto livre que cita ssam_code ou ssam-text (ou pede a sintaxe de ddl/flow/html). Nunca para `check-job`,
  `check-delivery`, `rules`, caminho de arquivo ou id de exemplo.
- As descrições de `ssam_map`, `o11_deliver`, `studio_deliver` e `ssam_job` citam o `ssam_code`.

Descoberta: `ssam_discover` manda para o `ssam_code` pedidos como "ler o módulo em código", "ver as entidades em SQL",
"escrever a tela em HTML", "sintaxe do ssam text" (rotas em `catalog/tools.json`). A seção `textRoute` traz também `code`:
a leitura e a escrita como `ssam_code`. "Tabelas" sem tela, com código, SQL, DDL ou entidade, vai para `data.ddl`. No modo
`packet`, uma intenção com rota de texto tem `next.deliver` = a escrita do `ssam_code` e `next.code` (grammar, read).

Código: `platforms/odc/facade/ssam-code.mjs`, registrado em `ssam.mjs`. Testes: `facade/tests/ssam-code.test.mjs`. Com
`SSAM_CODE_CLI_O11`/`SSAM_CODE_CLI_ODC` (pasta das CLIs), os exemplos do `grammar` são aplicados do zero numa fixture e lidos
de volta iguais nas duas faixas (O11 `reactive-ui.oml`, ODC `insurance-reactive-r8.oml`). O exemplo sem UI é aplicado também
nos módulos vazios (O11 `blank-service.oml`, ODC `blank-mobile.oml`).

### 0.1 Famílias da fachada (12/10/2026, sessão das telas escritas à mão)

Regra do dono: uma regra por família, nunca um remendo do caso. Forma com um só sentido é normalizada e listada em
`normalizations` (`[{rule, at, note}]`, na resposta, também na recusa). Forma com dois sentidos é recusada uma vez, com o
que dar.

- Forma da chamada (`call-shapes.mjs`, antes do schema): sinônimos de `action` (syntax, get, deliver, apply...) e de `part`
  (data, sql, flow, screen, ui...); o texto em `html`, `ddl`, `sql`, `logic`, `flow`, `code`, `content`, `source`; o
  elemento em `screen`, `block`, `entity`; tudo isso dentro de `data {...}`; `also` com um item só, item que é só texto,
  item com `ops`; `ops` fora do `job` em `o11_deliver`/`studio_deliver`/`ssam_job`/`o11_job`; `job` que é uma op só.
- Escrita (`writeCall`): `part` sai da forma do texto; lista de documentos `<screen>`/`<block>` em `text` = uma tela nova
  por documento; só `ops` = o job; `patch` sem `part`; as partes na ordem que a entrega pede (dados, blocos novos, telas
  novas, actions, edições de tela). Sem limite de 50 nas listas (`text`, `also`, `ops`).
- Ops do job (`normalizeCodeOps`, em toda entrada de job): `set {props:{...}}` = um `set` por propriedade; `property` =
  `prop`; `rename {newName|to}` = `name`; `create {kind}` = `type`; chaves de verbo cru dentro de `data` sobem; texto ao
  lado de `data` (`ddl`, `flow`, documento `html`, `screen`+`edit`) entra em `data`.
- Leitura: lista de telas (ou de elementos de dados) lida uma a uma numa resposta; orçamento abaixo da menor página do
  ddl/digest = a menor página (também no `ssam_map`).
- Cartões: as formas exatas que o parser aceita (`forms`), cada uma dentro de um exemplo lido de volta nas duas faixas.
  Declaração de uma linha sem `;` (`client variable V: Type = default`); default de Date é `#2026-01-31#`; nada depois
  de `end`, `raise` ou `navigate`; `assign` com linhas 2 espaços mais fundas; popup do zero (`<popup show="Var">`,
  abrir/fechar por screen action; os eventos de dentro ficam no Transition Fade, o padrão da plataforma ali, que o
  kernel grava e a leitura omite: o exemplo os escreve sem ele, `os-onclick.Transition` só para outra transição).
- Recusa (`refusal-problems.mjs`): todo problema uma vez. Problema de nome que outra parte do job declara, quando essa
  parte falhou por causa própria, vira uma entrada `CASCADE` (contagem, códigos, partes, nomes). `APPLY_SKIPPED` vira
  uma entrada. A raiz diz quantos bloqueia (`blocks`). Grupo de um texto: o ponteiro uma vez e as linhas (`lines`).
  Na recusa da sessão (244 ponteiros), 173 viram uma entrada só. Patch de "nome mais próximo" de um problema da cascata
  não é oferecido (`patchesLeftOut`): o job declara o nome.
- Resposta: `removed` só nomeia o que existia antes da escrita. Os nós da casca de uma action nova não são exclusão.

Testes: `facade/tests/familias-fachada.test.mjs` (13; os 13 falham na base `fc09cbdf` e passam aqui) e a ida e volta dos
cartões em `ssam-code.test.mjs` com as CLIs (O11 e ODC: popup, variável de cliente e cada forma exata lidos de volta).

## 1. O que está ligado

Regra de corte do plano (seção 8): uma parte só é ligada no MCP se o ponto fixo fechar em 100% no corpus; se não fechar,
fica só como leitura. Todas as idas fecharam o ponto fixo em 100% e todas as voltas fecharam a sua bateria em 100%, medidas
de novo na cabeça da junção (seção 4). Por isso as quatro rotas estão ligadas.

| Rota do `ssam_discover` | Pedido típico | Leitura (1ª chamada) | Entrega pronta (2ª chamada) |
|---|---|---|---|
| `ui.screen-html` | "criar uma tela de cadastro de clientes" | `ssam_discover {intent, lane, app, packet:true}` (o pacote de UI) | `o11_deliver` / `studio_deliver` com `{op:"html", data:{html:"<screen ...>"}}` |
| `ui.screen-html-edit` | "ajustar o espaçamento da tela de pedidos", "ta tudo sem css" | `ssam_map {view:"html", screen}` | a mesma entrega com `{op:"html", data:{screen, basedOn, edit:[...]}}` (a `continuations.edit` da leitura já vem pronta) |
| `data.ddl` | "criar entidades, atributos, relacionamentos, índice único" | `ssam_map {view:"ddl", element?}` | entrega com `{op:"spec", data:{basedOn, ddl}}` (só as declarações que mudam; contrato em `spec.ddl`) |
| `logic.flow` | "criar uma server action que calcula o desconto", "criar uma screen action na tela Pedidos" | `ssam_map {view:"flow", element}` | entrega com `{op:"logic", data:{flow:[{text, basedOn}]}}` |

A B1 (criar tela) não tem ponto fixo próprio: compila o texto da C1, que fechou em 100%, e o critério dela é a recriação
(≥ 95%, medido 97,3%, com as 5 telas restantes listadas por causa na seção 2). Liguei a rota `ui.screen-html` por isso; se o
dono preferir esperar a prova ao vivo, uma linha em `WIRED` a deixa só como leitura. A chave `WIRED` de
`platforms/odc/facade/text-routes.mjs` guarda essa decisão, e é uma chave de verdade (desde 12/10/2026). Uma rota marcada
`false`:
- no `ssam_discover`, responde só a leitura, sem chamada de entrega, e diz que a volta não está ligada;
- perde a entrega pronta da sua leitura: `ssam_map {view:"html", screen}` traz `continuations.edit: null` (e a nota diz por
  quê) quando `ui.screen-html-edit` está desligada;
- tem a forma de escrita recusada pelo servidor `ssam` antes de o kernel rodar: `o11_deliver`, `studio_deliver` e
  `ssam_job`/`o11_job` respondem `TEXT_FORM_NOT_WIRED`, com o op e o ponteiro, para o op `html` na forma documento
  (`ui.screen-html`) ou edição (`ui.screen-html-edit`), o op `spec` com `ddl` (`data.ddl`) e o op `logic` com `flow`
  (`logic.flow`). As mesmas regras do kernel decidem a forma (`textFormOf`).

O kernel em si não lê `WIRED`: a CLI do desenvolvedor continua aceitando as quatro formas. A chave vale para o MCP.

### Como a rota sai na resposta

- O `ssam_discover` acrescenta `textRoute` logo depois de `intent`: `{schema:"ssam-text-route/1", id, title, wired, form,
  read, readWhy, call, slots, rules, contract, also?, why}`. `call` é a chamada da faixa pedida: na ODC, o `studio_deliver`
  do servidor `ssam` já com `feature`, `module`, `owners` e `changes`.
- O classificador (`text-routes.mjs`) é separado da pontuação de capacidades e das rotas de ferramenta, pelo mesmo motivo da
  `tool-routing.mjs`: guarda os verbos (criar ou mudar), não lê palavras-chave, sinônimos nem notas do índice, e não muda
  `matches`, `contracts` nem `tools`. Recusa pedidos de protótipo, Traditional Web, cópia, troca de chamadores, registros de
  dados, valores em ambiente, Service Center ou Portal, links, depuração e o que pertence a módulo, app, role, referência,
  processo ou integração. Renomear, mover ou apagar uma tela, um bloco ou uma action inteira continua com as capacidades de
  refatoração (`refactor.*`).
- A seção entra depois do modelo e da seção do OutSystems UI, antes das seções C07 (exemplo provado, gramática dos passos,
  valores), no nível mais rico que couber: inteira (com o cartão do contrato, até 4 KB), sem o cartão (ponteiro e
  expansão), ou só a chamada. Numa resposta inteira (32 KB ou mais), quando nem a forma sem o cartão cabe, o modelo é
  orçado de novo com esse piso a menos (`size.reserved.textRoute`), desde que não perca bindings, exemplos, contratos,
  operações ou resumos dos matches, nem o nível da lista do OutSystems UI; se perderia, o piso é o da chamada sozinha. Antes
  de qualquer piso, a seção usa os metadados que o OutSystems UI também pode liberar (jobs relacionados, detalhe da
  identidade, notas, lista de compartilhadas), cada um dito em `size.truncated`. Abaixo de 32 KB não há piso: a seção ocupa
  só o que sobra, e o que não coube é dito em `size.truncated`.
- Num pedido misto ("criar a entidade Pedido e publicar o módulo"), a rota sai antes das ferramentas serem encaixadas e
  volta no espaço que elas deixam, como as seções C07.
- A descrição do `ssam_discover` ganhou uma frase sobre `textRoute`.

## 2. O que ficou só leitura, ou de fora, e por quê

Nenhuma das quatro rotas ficou só leitura pela regra de corte. Ficam de fora, com o motivo:

| O quê | Situação | Por quê |
|---|---|---|
| Traditional Web | a op `html` recusa (`HTML_TRADITIONAL`); a leitura marca os widgets como `os-opaque` | decisão 7 do dono: a D2 vem depois de B e C provados ao vivo |
| O digest (`ssam_map view:"digest"`) e as ops `logic`/`spec` em JSON | continuam como estão | decisão 8: continuam por compatibilidade e para criação em massa; as rotas apontam para o texto |
| B1, as 5 telas que não voltam iguais na recriação | as 3 Splash de template (record literal no O11) e a `DcipsLogin` (placeholder órfão) são **recusadas** antes de gravar; a `FloodQuotes/PropertyCoverage` (margem 0 de imagem no ODC) **volta diferente sem recusa** | o critério da B1 é recriação ≥ 95% (medido 97,3%); o caso da margem 0 é a única diferença silenciosa medida e está em `corpus.json` (`recreation.known`) |
| Merge de 3 vias dos textos de dados e de lógica | resolvido na junção `feat/texto-ssam-2` (seções 7 e 8): o texto escrito sobre uma leitura antiga é juntado com o que mudou no Studio desde ela | antes, a lógica recusava (`FLOW_BASE_CHANGED`) e os dados só ecoavam o `basedOn` (um atributo acrescentado no Studio e ausente do texto era apagado) |
| Mapeamento de registro campo a campo no O11 | resolvido na junção `feat/texto-ssam-2` (seção 8): lido e escrito como `Origem mapTo { Campo: valor }`, a `TypeConversion` nativa; o T2 de mapeamento recusa com o patch nas duas faixas | o Model API público não tem o mapeamento; as classes públicas de `ServiceStudio.Framework` têm (`docs/TEXTO-LOGICA.md`, "Mapeamento de registros no O11") |
| Rota no pacote de trabalho (`packet:true`) | resolvido na seção 15: o pacote traz `text` (leitura, chamada pronta, gramática, exemplo provado, regras do dono) | antes o pacote não trazia a rota e o reteste do dono de 12/10/2026 escreveu tudo em JSON |
| Tela ou data action criada pelo texto de lógica | resolvido na junção `feat/texto-ssam-2` (seção 8, lane `feat/tx3-owner`): o cabeçalho nomeia o dono (`action Tela.Nome`, `data action Tela.Nome`), a rota `logic.flow` responde e a op `html` de documento liga os eventos às actions que um texto do mesmo job declara | `docs/TEXTO-LOGICA.md`, seção "Screen, block e data actions pelo texto"; Traditional continua fora (decisão 7) |

## 3. Correções feitas na junção

1. **As formas edição (C2) e documento (B1) da op `html` não se sobrepõem.** A aplicação testava a edição primeiro e o
   preflight testava o documento primeiro, e um `<screen>` inteiro com `basedOn` e `screen` satisfazia as duas. Regra única
   no motor (`ScreenHtmlEdit.IsEdit` e `ScreenDocument.IsDocumentOp`): é edição o que traz `edit`, ou `basedOn` com
   `screen`, ou `basedOn` sem documento; o resto que traz `<screen>`/`<block>` é documento. Teste:
   `ScreenDocumentTests.AnOpIsEitherTheEditOfAReadingOrTheDocumentFormNeverBoth`.
2. **Texto de lógica com fim de linha do Windows é o mesmo texto.** O parser de `ssam-flow/1` recusava o `\r` ("unexpected
   text"), então um cliente Windows, ou um checkout com `autocrlf`, tinha o texto recusado. O parser e a entrada da op
   `logic` leem CRLF como LF (o parser de dados já fazia isso). Apareceu como 3 falhas de `FlowEditTests` na bateria ODC.
3. **A `continuations.edit` da leitura de tela na ODC vinha sem `feature`, `module`, `owners` e `changes`**, que o
   `studio_deliver` do servidor `ssam` exige com um job. Agora vem com os quatro, a tela como `owner`.
4. **O texto de dados ganhou chave própria no contrato** (`api --op spec`, chave `ddl`). A DL2 tinha escrito essa explicação
   em `spec.rules`, que toda resposta que cita a op `spec` carrega (721 bytes a mais em cada; a lista do OutSystems UI de um
   pedido de tela deixou de caber). `spec.rules` só aponta para ela; a rota `data.ddl` cita `spec.ddl`.
5. **A frase da leitura de fluxo nas instruções do servidor** (LG1) foi para depois da frase do mapa do módulo: estava entre
   duas frases que o teste da entrada MCP lê em sequência.
6. **Conflitos dos merges**, resolvidos juntando os dois lados: os verbos novos das duas CLIs (`html-edit`,
   `html-edit-battery`, `html-recreate`, `ddl`, `flow`, `flow-battery`), as views do `ssam_map` (`map`, `digest`, `ddl`,
   `flow`, `search`, `uses`, `html`; `element` como lista só na view `flow`), as leituras no leitor de snapshot, no armazém
   de índices e no builder, o verbo `flow` no catálogo e as seções `c2` e `recreation` do manifesto do corpus.

## 4. Números

### Corpus do plano, medido de novo na cabeça da junção

Os 34 módulos de `C:\t\html-plan\unique.json`, com os testes de cada lane rodando na bateria completa da cabeça (O11 e ODC).
Todos passaram e repetem os números das lanes.

| Parte | O11 | ODC | Critério do plano |
|---|---|---|---|
| C1, ida de tela: ponto fixo e cobertura | ponto fixo em todas as telas e blocos; 38.024 de 38.076 widgets representados (99,86%), 140 telas e 329 blocos | ponto fixo; 4.580 de 4.621 (99,11%), 46 telas e 77 blocos | ponto fixo 100%; ≥ 99,5% no conjunto (99,78%) |
| C2, volta de tela: bateria sintética (semente 1) | 2.690 de 2.690 edições | 676 de 676 | ≥ 3.000 edições em 100% (3.366) |
| C2, os 2 pedidos de correção do transcript | 0280-ajuste e 0285-sem-css: 2 chamadas cada, aceitos, aplicação de 3,3 a 4,9 s | — | ≤ 2 chamadas, 0 recusas, ≤ 60 s |
| B1, recriação das telas reais | 136 de 140 (97,1%) | 45 de 46 (97,8%) | ≥ 95% (181 de 186, 97,3%) |
| DL1, ida de dados: ponto fixo | 56.958 de 56.958 elementos em 28 módulos | 3.239 de 3.239 em 6 | 100% |
| DL2, volta de dados: bateria (semente 11) | 1.194 de 1.194 edições | 258 de 258 | ≥ 1.000 em 100% |
| DL2, o pedido de dados do transcript | 1 leitura e 1 entrega, 0 recusas, 81 elementos exatos (antes: 20 chamadas, 4 de 5 entregas recusadas) | — | ≤ 2 chamadas, 0 recusas |
| LG1, ida de lógica: ponto fixo | 4.439 de 4.439 actions | 801 de 801 | 100% (5.240) |
| LG2, volta de lógica: bateria | 3.399 de 3.399 edições (1 action em 6) | 1.724 de 1.724 (1 em 2 no teste) | ≥ 3.000 em 100% |

A bateria completa da LG2 nas lanes deu 6.868 de 6.868 edições e reversões; a da C2, numa segunda semente, 6.224 de 6.224.

### Aceite da B2

- 20 frases reais por rota, 10 em português e 10 em inglês (`tests/fixtures/text-routes-phrases.json`): os pedidos dos
  transcripts que o plano mediu, os pedidos de mudança de modelo dos fixtures do discover e frases no jeito do dono.
- Nas duas faixas, as 80 frases (160 respostas) dão a rota certa, com a leitura e a entrega prontas na 1ª resposta, e
  nenhuma passa de 40 KB (a maior tem 40.957 bytes). 138 das 160 levam também os slots e as regras do dono (O11 73 de 80,
  ODC 65 de 80) e 122 levam o cartão do contrato inteiro; as outras 22 levam a leitura e a chamada (quando o piso maior
  tiraria do modelo bindings, exemplos, contratos ou a lista do OutSystems UI, fica o piso da chamada).
- As chamadas prontas de cada rota e faixa passam no schema vivo do servidor `ssam` (Ajv).
- Nos 630 pedidos de operação dos fixtures do discover (121 de avaliação, 95 retidos e 414 dos verificadores), só os 5
  pedidos mistos ganham rota, sempre a da parte de modelo.
- Teste: `platforms/odc/facade/tests/text-routes.test.mjs`.

### Contexto fixo (`platforms/odc/scripts/contexto-fixo.mjs`)

| Medida | Base `45a849b0` | Cabeça | Diferença |
|---|---|---|---|
| Instruções do servidor | 4.010 B | 4.100 B | +90 B |
| Ferramentas (descrição + schema, 79) | 164.827 B (~74.921 tokens) | 167.389 B (~76.086 tokens) | +2.562 B (~+1.165 tokens) |
| Núcleo carregado de uma vez (14 ferramentas) | 41.464 B | 44.026 B | +2.562 B |
| `AGENTS.md` / `kernel/AGENTS.md` | 4.429 / 127.096 B | 4.896 / 130.661 B | +467 / +3.565 B |

O crescimento vem do `ssam_map` (as views `html`, `ddl` e `flow` com seus argumentos, das lanes) e da frase do
`ssam_discover`.

## 5. Baterias

Bateria completa nas duas worktrees, na mesma janela e com ambiente isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`,
`SSAM_NO_WARM=1`, autoridade, TEMP, índice e fricção privados): a base `45a849b0` (worktree `tx-int-base`) e a cabeça
(`tx-int`, com a B2). Scripts e saídas em `C:\t\tx\int` (`battery.ps1`, `bat-base`, `bat-head`,
`battery-diff.json`).

| Suíte | Base | Cabeça | Novas falhas |
|---|---|---|---|
| Anvil.Tests (O11, com `ANVIL_STUDIO_DIR`) | 2.760: 2.707 ok, 53 falhas | 2.932: 2.876 ok, 56 falhas | 3: `FlowEditTests` (CRLF); corrigidas, e as classes afetadas deram 316 de 316 depois |
| Anvil.Tests.Odc | 805: 804 ok, 0 falhas, 1 ignorado | 963: 959 ok, 3 falhas, 1 ignorado | as mesmas 3; corrigidas, 157 de 157 depois |
| Bridge.Tests | 149 de 149 | 149 de 149 | 0 |
| Builder.Tests | 7 de 7 | 7 de 7 | 0 |
| Fachada (`node --test` em todos os arquivos) | 1.778: 1.711 ok, 29 falhas, 32 todo | 1.805: 1.732 ok, 35 falhas, 32 todo | 6, classificadas abaixo |

**Falhas iguais nos dois lados (ambiente):**
- O11, 52 `ScreenCoverageTests`: as fixtures `outsystems-ui.oml` e `outsystems-ui-web.oml` não vêm no git. Copiadas
  (somente leitura) das fixtures da pasta operacional, a classe deu 150 de 150 nas duas worktrees.
- O11, 1 `FunctionCatalogTests`: falta `catalog/functions-11.55.91.json` para o Service Studio instalado.
- Fachada, 29: os casos "proven-current" da O11 nos testes de catálogo (dependem de carimbos locais de job com o hash do
  binário), as leituras com captura que pedem a chave da bridge no diretório de autoridade privado, DPAPI, o builder
  real e a leitura ODC real.

**As 6 novas da fachada:**

| Teste | Causa | Situação |
|---|---|---|
| `job-guidance`: a entrada MCP diz como obter contratos | a frase da leitura de fluxo (LG1) no meio das instruções | corrigida (correção 5), passa |
| `discovery`: o composto de listagem leva as bindings | o piso da rota de texto cortava as bindings | corrigida (o piso maior não tira conteúdo dos matches), passa |
| `discover-osui`: tela na O11 leva a lista do OutSystems UI inteira | o contrato da `spec` cresceu (DL2) e o piso da rota | corrigida (correção 4 e a rota usa metadados antes do piso), passa |
| `mcp`: a fachada serve tudo num servidor stdio | concorrência na suíte cheia | passa sozinho |
| `preview`: o worker gerenciado abre uma vez e termina | tempo (parada em 4 s) com a máquina carregada | passa sozinho, duas vezes |
| `prototype-render-farmavirtual` 12: captura ≤ 5 s | tempo: 5,9 a 7,8 s | falha também na base nas mesmas condições (7,4 a 7,6 s) |

**Verificação final**, com a CLI recompilada depois das correções: os 13 arquivos do discover e do MCP (`text-routes`,
`discover-tools`, `discover-osui`, `discovery`, `job-guidance`, `mcp`, `module-html`, `discovery-prototype`,
`tool-routes`, `pacote-trabalho`, `pacote-laneE-discover`, `discovery-data`, `discovery-shared`) deram 130 de 132; as
2 falhas são leituras com captura que a base também não passa. Os casos "proven-current" dos testes de catálogo dependem
dos carimbos do binário: depois de recompilar, os JobTests da ODC rodados no build final deram 157 de 157 e todo o catálogo
ODC voltou a passar; as 22 falhas que restam no catálogo são os casos da O11 que a base também não passa.

**Rede html-replay rápida** (`C:\t\html-replay\run.mjs --quick`, só nesta worktree, 214 jobs de UI reais): 148 aceitos e 66
recusados, mediana de 21,9 s e p90 de 91,7 s por job com a máquina carregada. Contra a réplica guardada do importador
(`proto-final.json`, commit `806779c9`, igual à base nos jobs html), 213 iguais e 1 com só a primeira mensagem do Verify
trocada (mesmo veredito, `VALIDATION_REFUSED`): **nenhum veredito mudou**. Contra `base-cd7e4f11.json` (o padrão do
`regress.ps1`), 201 iguais, 8 com CSS do tema ou mensagem diferentes e 5 piores, que são regras da base do importador
(`DROPDOWN_ITEM_SCOPE`, CSS inválido) e saem iguais na `proto-final`. A réplica da base `45a849b0` foi interrompida para
aliviar a máquina; a `proto-final` faz esse papel.

## 6. Lacunas

- **Nada ao vivo.** A prova ao vivo do plano (criar e corrigir uma tela, uma entidade e uma action num módulo real, com o
  dono) é a próxima etapa. O snapshot e o merge nativo do Studio não entram em nenhum número desta junção.
- **B1:** o replay completo dos 302 jobs `html-fragment`/`html-page` não rodou; a rede rápida (214 jobs) manteve todos os
  vereditos. Das 5 telas que não voltam iguais na recriação, a da margem 0 de imagem no ODC é uma diferença silenciosa;
  uma regra no motor (reler a tela criada e comparar com o texto, como a C2 faz) a tornaria impossível.
- **C2:** a bateria sintética não cobre mover para outro pai, troca de tag, argumentos de bloco, renomear dados nem editar
  `var`/`aggregate`; esses casos estão só nos testes unitários e de job.
- **Dados e lógica:** os três limites desta parte (o merge de 3 vias com a leitura, o mapeamento campo a campo no O11 e a
  screen ou data action criada pelo texto) foram tirados na junção `feat/texto-ssam-2`; o que eles ainda não cobrem está
  na seção 8, "O que ainda fica".
- **Rota do texto:** não entra no pacote de trabalho (`packet:true`); 22 das 160 respostas do aceite levam só a leitura e a
  chamada, sem as regras do dono (o modelo dessas respostas não tinha folga sem perder conteúdo). O classificador é por
  conceito e cobre as frases medidas; pedidos fora dele simplesmente não ganham `textRoute` (as capacidades continuam
  respondendo).
- **Contexto fixo:** +2.562 bytes nas ferramentas (cerca de +1.165 tokens por turno), quase tudo do `ssam_map` das lanes.
- **Ambiente dos testes:** as fixtures do OutSystems UI e o catálogo de funções do Studio instalado não vêm no git; as leituras
  com captura pedem a chave da bridge no diretório de autoridade; os casos "proven-current" do catálogo dependem dos carimbos
  locais do binário (qualquer recompilação os torna históricos até os JobTests rodarem de novo).
- **O que não foi feito aqui:** liberação, envio para o servidor e push. Esta etapa não publica nada; a liberação do 24º envio
  e a subida para o servidor do SSAM MCP são da sessão principal.

## 7. Merge de 3 vias dos textos de lógica e de dados (lane `feat/tx3-merge`)

Feito em 12/10/2026 na branch `feat/tx3-merge`, sobre `c4d71776`. Nada ao vivo: sem Studio, sem MCP `ssam`, sem push.

Antes, a lógica recusava o texto escrito sobre uma leitura antiga (`FLOW_BASE_CHANGED`) e os dados só ecoavam o `basedOn`:
o texto era comparado com o módulo na hora de aplicar, então um atributo acrescentado no Studio depois da leitura, ausente
da declaração enviada inteira, era apagado. Agora os dois textos fazem o que a tela (C2) já fazia:

- **A leitura guardada.** Lógica: toda action servida pela `view:"flow"` deixa a sua leitura em
  `<sha256>.kernel.flow-<textSha>.json` ao lado do arquivo de fluxo (a fachada grava; a CLI fria `flow --action` também).
  Dados: o texto da captura que a `view:"ddl"` serviu (`<sha256>.kernel.ddl.json`), achado pelo `basedOn`.
- **O merge.** Base = a leitura, theirs = o módulo agora, ours = o texto entregue, casados pela chave do modelo (nós,
  parâmetros e locais; elementos de dados pela `@key`). O que só um lado mudou fica; o mesmo elemento mudado dos dois
  lados fica com a entrega e sai listado (`merged.conflicts`: chave, o que o Studio tinha, o que foi entregue); o que o
  Studio acrescentou nunca é apagado pela ausência no texto; o que a entrega removeu e o Studio mudou é removido e listado;
  o que o Studio removeu e a entrega mudou volta como elemento novo e é listado. Detalhes: `docs/TEXTO-LOGICA.md` (seção
  "Merge de 3 vias") e `docs/LEITURA-RAPIDA.md` ("`basedOn` e o merge de 3 vias").
- **Sem a leitura guardada**: lógica, `FLOW_BASE_CHANGED` com o texto atual e a edição pronta (`edit`); dados, as
  declarações comparadas com o módulo agora, mas nada que elas deixam de fora é apagado (`DDL_BASE_UNKNOWN`).
- Código: `kernel/src/Anvil.Core/Kernel/FlowMerge.cs`, `DataDdlMerge.cs` (puros), `Verbs.Flow.cs`, `Verbs.Ddl.cs`,
  `ModuleIndex.cs` (`SaveFlowReading`/`LoadFlowReading`), `ModuleFlow.cs` (`FlowReading`), `platforms/odc/facade/module-map.mjs`.

| Medida (12/10/2026, corpus do plano, semente 1) | O11 | ODC |
|---|---|---|
| Merge da lógica: casos exatos (`flow-merge-battery`; O11 1 action em 6, ODC 1 em 2) | 3.593 de 3.593 | 1.848 de 1.848 |
| … disjuntos (os dois lados ficam, nenhum conflito) | 1.058 | 470 |
| … sobrepostos (conflito listado, a entrega fica, o resto como o Studio deixou) | 2.535 | 1.378 |
| Merge dos dados: casos exatos (`ddl --merge-battery`, 2 rodadas) | 770 de 770 | 150 de 150 |
| … disjuntos / sobrepostos | 434 / 336 | 86 / 64 |

O ponto fixo e as baterias de antes (LG1, LG2, DL1, DL2) continuam em 100% (seção 4; resultados da rodada na resposta da
lane).

O que este merge ainda não cobre:
- Partes sem identidade de um nó (as atribuições de um `assign`, os casos de um `switch`, as fontes de um aggregate) são
  comparadas em grupo: duas mudanças em atribuições diferentes do mesmo nó, uma de cada lado, são um conflito (fica a
  entrega, listado), não uma junção.
- Renomear um nó ou uma local reescreve as expressões do outro lado, não o texto de SQL ou JavaScript.
- A leitura precisa estar no mesmo armazém que o processo do job vê (`ModuleIndexStore.Default`, a mesma dependência da C2).
- Nada disso foi provado ao vivo (Studio aberto mudando a action entre a leitura e a entrega).

## 8. Segunda junção: os três limites tirados (branch `feat/texto-ssam-2`)

Feita em 12/10/2026 sobre `c4d71776`, com merge `--no-ff` das três lanes, nesta ordem: `feat/tx3-merge` (`7410f1f6`),
`feat/tx3-map` (`c935a3c4`) e `feat/tx3-owner` (`7f942d57`). Nada ao vivo: sem Studio aberto, sem MCP `ssam`, sem tenant,
sem push.

**A pergunta do dono** ("isso é um limite técnico da sua capacidade ou um limite imposto por você de forma arbitrária?"):
nenhum dos três era limite da plataforma nem de capacidade. Eram cortes de escopo das lanes LG2 e DL2, trabalho que ainda
não tinha sido feito, e cada um tinha caminho. Os três estão tirados nesta branch:

| Limite (até `c4d71776`) | Por que existia | O que mudou |
|---|---|---|
| Se a action mudou desde a leitura, a entrega era recusada (`FLOW_BASE_CHANGED`); nos dados, o `basedOn` só era ecoado (um atributo acrescentado no Studio e ausente do texto era apagado) | as lanes LG2 e DL2 não guardavam a leitura; a tela (C2) já fazia o merge com a leitura guardada | a leitura fica no armazém de índices e o texto é juntado em 3 vias pela chave do modelo (`FlowMerge`, `DataDdlMerge`): o que só um lado mudou fica; conflito real, a entrega vence e sai listado em `merged.conflicts`; o que o Studio acrescentou nunca é apagado (seção 7) |
| No O11, mapeamento de registro campo a campo não saía pelo texto | o leitor percorre só o Model API público (`OutSystems.Model.V1`), que não tem o mapeamento | o mapeamento é a `TypeConversion` nativa da atribuição ou do argumento, em classes públicas de `ServiceStudio.Framework` (o mesmo assembly de onde o kernel já usa `Entity.EntityIndices`): lido e escrito como `Origem mapTo { Campo: valor }`, a forma do ODC; o T2 de mapeamento passou a recusar com o patch também no O11 (`docs/TEXTO-LOGICA.md`, "Mapeamento de registros no O11") |
| Screen action, action de bloco e data action nasciam só pela op `logic` em JSON com `owner` | o cabeçalho do texto não tinha dono (forma da LG1) | `action Tela.Nome` e `data action Tela.Nome [fetch=OnDemand]`: a leitura imprime o dono e o texto sem `@key` cria a action sob ele; o documento `html` liga os eventos às actions que os textos do mesmo job declaram (`docs/TEXTO-LOGICA.md`, "Screen, block e data actions pelo texto") |

**Conflitos do merge**, resolvidos juntando os dois lados: os verbos novos das duas CLIs (`flow-merge-battery`,
`flow-create-battery`), o registro `FlowPlan` de `Verbs.Flow.cs` (`Merged`, do merge, e `Shell`, da casca do documento),
a versão do extrator, os testes de `FlowApplyOdcTests` e `FlowBatteryCorpusTests`, os pisos de
`flow-battery-expected.json` (`o11Map` e `create`) e uma linha desta página. `docs/TEXTO-LOGICA.md` juntou sem conflito.

**Correções da junção:**
1. **Extrator 6.** As duas lanes subiram `ModuleFlow.Extractor` e `FLOW_EXTRACTOR` de 4 para 5, cada uma com outro texto
   (o mapeamento, o dono). Juntos são 6: um fluxo ou uma leitura guardada por uma lane sozinha não é servido nem usado
   como base de merge.
2. **O merge leva o dono.** `FlowMerge` montava a action juntada sem o dono: o texto juntado saía sem `Tela.` no
   cabeçalho, e um dono diferente na entrega (mover a action) era ignorado sem aviso. Agora o dono é o de agora (vale a
   tela renomeada no Studio depois da leitura), esteja ele na entrega como na leitura, pelo caminho ou de fora; outro
   dono vai para a volta, que o recusa (`FLOW_ACTION_OWNER`) como numa edição da leitura atual. Teste:
   `FlowMergeTests.TheOwnerIsTheActionsOwnerNowAndAMoveIsLeftToTheWayBack`.
3. **`FlowMappingTests` com CRLF.** Num checkout com `core.autocrlf`, o literal do teste vinha com `\r\n` e a leitura com
   `\n` (o mesmo caso da correção 2 da seção 3, agora no teste): a comparação tira o `\r`.
4. **Piso da bateria de criação no O11.** Com o mapeamento do O11, a regra T2 recusa também no O11 o For Each novo que só
   mapeia. Na bateria de criação, 12 modelos a mais são recusados como action nova (32 `FLOW_FOREACH_LIST_ACTION`; eram
   20) e 7 donos ficam sem modelo de data action: 176 data actions criadas em vez de 183, todas exatas. O piso
   `create.o11.DataAction` foi para 176. É a regra fazendo o que deve: um laço que só mapeia, escrito novo, vira
   `ListAppendAll ... mapTo`.

### Números

Corpus do plano (`C:\t\html-plan\unique.json`: 28 módulos O11 e 6 ODC), semente 1, código final desta branch, ambiente
isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, TEMP, índice, autoridade e fricção privados).

| Rota ou bateria | O11 | ODC | Critério |
|---|---|---|---|
| LG1, ponto fixo da lógica | 4.439 de 4.439 actions (43.129 nós) | 801 de 801 (7.176 nós) | 100% |
| DL1, ponto fixo dos dados | 56.958 de 56.958 elementos | 3.239 de 3.239 | 100% |
| C1, ponto fixo das telas e cobertura | 140 telas e 329 blocos; 38.024 de 38.076 widgets (99,86%) | 46 telas e 77 blocos; 4.580 de 4.621 (99,11%) | ponto fixo 100% |
| LG2, bateria de edição da lógica (O11 1 action em 6, ODC 1 em 2) | 3.399 de 3.399, e 3.399 de 3.399 desfeitas | 1.724 de 1.724, e 1.724 de 1.724 | 100% |
| DL2, bateria dos dados (semente 11) | 1.194 de 1.194 | 258 de 258 | 100% |
| C2, bateria das telas | 2.690 de 2.690 | 676 de 676 | 100% |
| B1, recriação das telas reais | 136 de 140 (97,1%; as 4 conhecidas, recusadas antes de gravar) | 45 de 46 (97,8%; a margem 0 conhecida) | ≥ 95% |
| Merge de 3 vias da lógica (O11 1 action em 6, ODC 1 em 2) | 3.594 de 3.594: 1.059 disjuntos sem conflito e 2.535 sobrepostos com o conflito listado (same-value 665, removed-changed 616, changed-removed 612, both-insert 642) | 1.859 de 1.859: 476 e 1.383 (355, 323, 320, 385) | 100% |
| Merge de 3 vias dos dados (O11 1 rodada, ODC 2) | 385 de 385 (217 disjuntos, 168 sobrepostos) | 150 de 150 (86 e 64) | 100% |
| Mapeamento de registros (todas as actions do O11) | 2.652 de 2.652 (1.326 `map` e 1.326 `remap`), e 1.326 de 1.326 desfeitas | não se aplica (o ODC escrevia `mapTo` novo; editar um existente falhava até a correção 1 da terceira junção, seção 13: a LG2 pulava os valores com `mapTo`) | 100% |
| Criação de screen e data action pelo texto (todos os donos) | 584 de 584 (408 screen e 176 data actions; 428 donos, 4 Traditional fora, 9 sem modelo utilizável) | 114 de 114 (110 e 4, em 110 donos) | 100% |

Os casos da bateria do merge variam um pouco entre rodadas, como a seção 7 explica (O11 3.594 contra 3.593 na lane; ODC
1.859 contra 1.845 a 1.848): ao desfazer um caso que removeu um nó, o nó volta com outra chave. Todos saem exatos.

As 160 respostas do aceite da B2 (80 frases por faixa) continuam dentro de 40 KB, com o contrato `logic.flow` maior (o dono
e o `mapTo`) e o `spec.ddl` e o `logic.flow` mais curtos do merge. Contexto fixo igual à base: instruções 4.100 B,
ferramentas 167.389 B; `kernel/AGENTS.md` +472 B (130.661 para 131.133) e `docs/DESENVOLVIMENTO.md` +122 B.

### Regressão

Comparada por nome de falha com a base `c4d71776` (worktree `tx3-int-base`), no mesmo ambiente isolado. Filtro das duas
suítes do kernel: `Flow|Logic|Text|Ddl|Spec|ScreenHtml|Job` no nome (inclui `JobTests`), sem os testes de corpus, que
estão nos números acima (O11 15 de 15, ODC 11 de 11).

| Suíte | Base `c4d71776` | Esta branch | Falhas novas |
|---|---|---|---|
| Anvil.Tests (O11, com `ANVIL_STUDIO_DIR`) | 812 de 812 | 849 de 849 | 0 |
| Anvil.Tests.Odc | 339 de 339 | 367 de 367 | 0 |
| Bridge.Tests | 149 de 149 | 149 de 149 | 0 |
| Fachada, 22 arquivos (`module-*`, `text-routes`, `discover-*`, `discovery*`, `job-guidance`, `mcp`, `tool-routes`, `pacote-trabalho`, `pacote-laneE-discover`, `pacote-laneE-responses`) | 197: 190 ok, 7 falhas | 200: 196 ok, 4 falhas | 0 |

As 4 falhas da fachada são as mesmas na base, pelo nome: a leitura com captura que pede a chave da bridge no diretório
de autoridade privado (`discovery`, as assinaturas de um composto), o tipo de app de uma captura O11 (`discover-osui`),
a entrada pública do `discovery-data` (o caso com orçamento de 12.000 bytes) e a ferramenta MCP `ssam_discover`
comparada com a CLI (tempo esgotado). As outras 3 da base (o índice ODC, o pacote sobre ele e a seção do OutSystems UI
na ODC) passam nesta branch. Dos testes do kernel, só um nome da base sumiu: o `FlowEditTests` do For Each que mapeia,
"permitido no O11", que a lane do mapeamento trocou pela regra nas duas faixas.

### O que ainda fica

- **Nada ao vivo.** Nenhum dos três foi provado num Studio aberto: a action ou a entidade mudando entre a leitura e a
  entrega, um mapeamento escrito num módulo real e publicado, uma screen action nascendo do texto num módulo do dono.
- **Merge:** renomes não reescrevem texto de SQL ou JavaScript; a leitura precisa estar no armazém que o processo do job vê
  (`ModuleIndexStore.Default`), senão vale o fallback (`FLOW_BASE_CHANGED` com a edição pronta, ou a recusa
  `DDL_BASE_UNKNOWN`); uma leitura de outro extrator (toda leitura anterior a esta branch) também cai no fallback. As
  partes sem identidade comparadas em grupo e o passo do Studio fora do fluxo foram corrigidos na revisão (seção 9).
- **Mapeamento no O11:** o corpus não tem mapeamento escrito por desenvolvedor (a bateria cria mapeamentos sintéticos sobre
  actions reais) e a execução em runtime não foi testada; o mapeamento de anexos do Send Email não é escrito (o nó fica
  opaco); renomear uma local com o nome de um campo-alvo de um `mapTo` da mesma action é recusado (`FLOW_NOT_EXACT`, nada
  fica), e com o nome de um atributo da origem, `FLOW_RENAME_CAPTURED` (revisão); os verbos crus e a op `logic` em JSON não
  recusam um `mapTo` sem conversão (o Verify do job pega).
- **Dono:** dono Traditional continua recusado (`FLOW_OWNER_KIND`, decisão 7), e a screen action Traditional nasce pela op
  `logic` em JSON; `X Record List` só resolve com a lista no módulo; a forma página antiga da op `html` não vê as actions
  declaradas por texto (só a forma documento); a mediana de tamanho do O11 está em 1,2464, com 0,0036 de folga até o
  teto 1,25; o corpus tem só 4 data actions ODC.
- **Suítes:** só os filtros acima; não rodei as suítes inteiras do kernel, o Builder.Tests nem a fachada inteira.

## 9. Revisão da segunda junção: as correções (branch `feat/texto-ssam-2`)

Três revisões da junção (perda de dados, semântica do merge, ponto fixo e mapeamento) acharam casos em que o texto
juntado, ou escrito sem a leitura, ainda perdia o que o Studio fez ou mudava o significado sem aviso. Todos foram
corrigidos neste commit, cada um com um teste que falha no código de `bf8f8aca` e passa depois: os testes novos rodados
sobre as duas árvores (`C:\t\tx3\fix\res\before-*.trx` e `after2-*.trx`) dão, antes, 18 falhas em 19 no O11 e 17 em 18 no
ODC (só o cenário de dados que já existia passava, ajustado para mandar o `basedOn`), e depois todos passam. Nada ao vivo.

| Achado da revisão | Correção | Teste (falha antes, passa depois) |
|---|---|---|
| `basedOn` opcional: texto de lógica com `@key` e declaração com `-- @key` eram lidos contra o módulo de agora (apagavam e revertiam o que o Studio fez); a lista de um texto descartava o `data.basedOn` | `basedOn` obrigatório: `FLOW_BASE_REQUIRED` e `DDL_BASE_REQUIRED`, com o texto (ou as declarações) de agora e a edição pronta; a lista de um texto usa o `data.basedOn` compartilhado | `FlowApplyScenarios.ATextOfAnActionNeedsTheReadItWasWrittenOn` e `DataStatementsNeedTheirReadAndGiveTheNext` (O11 e ODC) |
| Dados sem a leitura guardada: o fallback só protegia o que ficava de fora e revertia propriedades e renomes do Studio | `basedOn` igual à captura em que o job roda compara com o módulo; sem a leitura, declaração que difere do módulo é recusada (`DDL_BASE_UNKNOWN`) com as declarações de agora e o `basedOn` para mandá-las | `DdlMergeTests.WithoutTheReadAStatementThatDiffersFromTheModuleIsRefused`; o cenário acima |
| Declaração com a chave de um elemento que a leitura não tem (criado depois; a chave veio do recibo) compilada crua; leitura de outro módulo aceita | a regra sem leitura, por elemento (`DDL_BASE_UNKNOWN`); `DDL_BASE_FOREIGN`; o recibo traz `nextBasedOn` (o texto que a op deixa, guardado no armazém) | `DdlMergeTests.AStatementOfAnElementTheReadDoesNotHaveIsRefusedNeverCompiledAsSent`; casos `foreign-read` e `newer-element` da `DdlMergeBattery` |
| Partes de um nó (atribuições, casos, fontes, filtros) e valores longos (SQL, JavaScript, mapeamento) comparados inteiros: a mudança do Studio numa parte que a entrega não tocou se perdia (listada como conflito) | partes casadas uma a uma (igual, identidade, lugar, semelhança) e juntadas propriedade a propriedade; o `Target` de um caso como conector; um valor que os dois mudaram, campo a campo (mapeamento, literal de registro) ou linha a linha (diff3), com conflito só no mesmo campo ou nas mesmas linhas | `FlowMergeTests.TheAssignmentsOfOneNodeAreMergedOneByOne`, `TheCasesAndTheFiltersOfOneNodeAreMergedOneByOne`, `AMappingMergesFieldByFieldAndCodeLineByLine`; casos `part|part`, `insert|part`, `code|code` e `code-same-line` da `FlowMergeBattery` |
| Passo que o Studio inseriu depois de um nó que a entrega remove (ou num ramo de caso que ela muda) virava ilha, sem aviso | o passo toma o lugar do nó removido; depois do merge, todo nó que o Studio tem no fluxo e a entrega não tirou do dela continua alcançado, senão o merge não sai (`FLOW_BASE_CHANGED` com a edição pronta) | `AStepTheStudioInsertedStaysInTheFlowWhenTheDeliveryRemovesWhatWasBeforeIt`, `StudioStepsTheMergeWouldLeaveOutOfTheFlowAreNotMerged` |
| Parâmetro, local ou nó removido de um lado e usado no que o outro escreveu | o que o Studio removeu e a entrega usa volta como novo (listado); o que a entrega removeu e o Studio passou a usar recusa (`FLOW_MERGE_REMOVED_USED`) | `AnElementRemovedOnOneSideAndUsedOnTheOtherIsNeverLeftDangling` |
| Um nome dado pelos dois lados a dois elementos (lógica e dados) | um elemento quando papel e tipo coincidem (valores da entrega na chave do Studio, listado); senão `FLOW_MERGE_NAME_TAKEN` / `DDL_MERGE_NAME_TAKEN` | `FlowMergeTests.ANameBothSidesGiveIsOneElementOrRefused`, `DdlMergeTests.ANameBothSidesGiveIsOneElementOrRefused` |
| O renome do merge reescrevia alias de fonte de aggregate e nome de campo de mapeamento | não reescreve (como o verbo `rename`); o conflito mostra o valor que vai ser escrito | `ARenameIsNotReadIntoSourceAliasesNorFieldNames` |
| Renome de parâmetro ou local para o nome de um atributo da origem de um `mapTo` que o cita: aceito como exato, mudando o significado | `FLOW_RENAME_CAPTURED`, com um nome livre | `ARenameAMappingWouldReadAsAnAttributeIsRefused` (O11 e ODC) |
| O11: mapeamento com atributo obrigatório vazio aceito pelo escritor e contado como exato pela bateria (164 de 575 escritas conferidas na revisão) | o escritor recusa (`FLOW_MAPPING_TYPES`) com o valor que preenche (`Id: NullIdentifier()`); a bateria mapeia todo obrigatório do destino e a remap nunca o tira | `FlowMappingTests.AMappingThatLeavesAMandatoryAttributeEmptyIsRefusedWithTheFix`; bateria `o11Map` |
| Regra T2 de mapeamento sem saída (cópia parcial no mesmo tipo) ou com patch que muda o sentido | o patch só é oferecido quando diz o que o laço diz (outro tipo, nenhum valor lê o elemento, nada fora do laço); senão o For Each é permitido | `FlowEditTests.TheMapRuleIsOfferedOnlyWhereThePatchKeepsTheLoopsMeaning` |
| A ordem de criação ignorava o destino de evento, o `refresh` e o `trigger` | entram na ordem; a recusa de nome sai com o ponteiro do texto | `TheActionsAnEventOrARefreshNamesAreWrittenFirst` (O11 e ODC) |
| ODC: lista de aggregate atribuída a lista da entidade só passava como `mapTo {  }` (dois espaços); no O11 essa forma quebrava | o mapeamento vazio é o valor: a leitura não o escreve (extrator 7) e a volta escreve o valor plano nas duas faixas | `AListAssignedAcrossTypesReadsAsTheValueWritten` (O11 e ODC) |

A regra do dono continua: num conflito real fica a versão da entrega, e todo conflito sai em `merged.conflicts`; o que a
entrega não tocou não se perde (fica, volta como novo, ou o texto é recusado com a edição pronta). Detalhes em
`docs/TEXTO-LOGICA.md` ("Merge de 3 vias", "Revisão da junção") e `docs/LEITURA-RAPIDA.md` ("`basedOn` e o merge de 3
vias").

### Números

Corpus do plano (`C:\t\html-plan\unique.json`: 28 módulos O11 e 6 ODC), semente 1, código final deste commit, ambiente
isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, TEMP, índice, autoridade e fricção privados;
scripts e resultados em `C:\t\tx3\fix`). Todos os testes de corpus passam: O11 15 de 15, ODC 11 de 11.

| Rota ou bateria | O11 | ODC | Critério |
|---|---|---|---|
| LG1, ponto fixo da lógica | 4.439 de 4.439 actions (43.129 nós) | 801 de 801 (7.176 nós) | 100% |
| DL1, ponto fixo dos dados | 56.958 de 56.958 | 3.239 de 3.239 | 100% |
| C1, ponto fixo das telas e cobertura | 140 telas e 329 blocos; 38.024 de 38.076 widgets (99,86%) | 46 telas e 77 blocos; 4.580 de 4.621 (99,11%) | ponto fixo 100% |
| LG2, bateria de edição da lógica | 3.399 de 3.399, e 3.399 desfeitas | 1.724 de 1.724, e 1.724 | 100% |
| DL2, bateria dos dados | 1.194 de 1.194 | 258 de 258 | 100% |
| C2, bateria das telas | 2.690 de 2.690 | 676 de 676 | 100% |
| B1, recriação das telas reais | 136 de 140 (97,1%) | 45 de 46 (97,8%) | ≥ 95% |
| Merge de 3 vias da lógica | 4.656 de 4.656: 2.092 disjuntos e 2.564 sobrepostos (os novos de um nó: `part|part` 455, `insert|part` 551, `code|code` 23, `code-same-line` 23) | 2.403 de 2.403: 1.003 e 1.400 (224, 278, 24, 24) | 100% |
| Merge de 3 vias dos dados | 441 de 441: 217 disjuntos, 168 sobrepostos e 56 recusados (`foreign-read` 28, `newer-element` 28) | 174 de 174: 86, 64 e 24 (12, 12) | 100% |
| Mapeamento de registros (todas as actions do O11) | 2.652 de 2.652 (1.326 `map`, 1.326 `remap`), 1.326 desfeitas, com todo obrigatório do destino mapeado | não se aplica | 100% |
| Criação de screen e data action pelo texto | 584 de 584 (408 e 176; 30 modelos recusados pela T1/T2, eram 32) | 114 de 114 (110 e 4) | 100% |

O ponto fixo, as baterias de telas e de dados e a criação repetem os números da seção 8; o merge da lógica tem os casos
novos de um mesmo nó (na seção 8: 3.594 e 1.859), o dos dados os casos recusados, e o mapeamento conta só escritas com os
obrigatórios preenchidos. O mapeamento vazio do ODC sai como o valor em 1 atribuição do corpus (`insurance-reactive`); a
mediana de tamanho segue 1,2464 (O11) e 1,477 (ODC).

### Regressão

Comparada por nome com a junção `bf8f8aca` (seção 8), no mesmo ambiente isolado e com o mesmo filtro das suítes do
kernel (`Flow|Logic|Text|Ddl|Spec|ScreenHtml|Job` no nome, sem os testes de corpus, que estão nos números acima).

| Suíte | Junção `bf8f8aca` | Este commit | Falhas novas |
|---|---|---|---|
| Anvil.Tests (O11, com `ANVIL_STUDIO_DIR`) | 849 de 849 | 866 de 866 (17 testes novos) | 0 |
| Anvil.Tests.Odc | 367 de 367 | 383 de 383 (16 testes novos) | 0 |
| Fachada, os mesmos 22 arquivos | 200: 196 ok, 4 falhas | 200: 198 ok, 2 falhas | 0 |
| Builder.Tests (o builder do ODC compila o leitor de fluxo que mudou) | não rodado | 7 de 7 | 0 |

As 2 falhas da fachada são as mesmas da junção e da base `c4d71776` (as leituras com captura que pedem a chave da bridge
no diretório de autoridade privado); as 2 de tempo da junção passam. O Bridge.Tests não foi rodado (nada da bridge mudou).
Três testes que já existiam mudaram com a regra: `DdlMergeTests.WithoutTheReadNothingTheStatementLeavesOutIsDeleted` virou
`WithoutTheReadAStatementThatDiffersFromTheModuleIsRefused` (sem a leitura, a declaração que difere do módulo é recusada,
não mais aplicada); `FlowMergeTests.TheSameValueChangedOnBothSidesKeepsTheDeliverysAndIsListed` lista o conflito da
atribuição (`assignment Total Value`), não mais o grupo (`assignments`); e o job do Studio de
`FlowApplyScenarios.DataStatementsOfAnOlderReadAreMergedWithWhatChangedSince` manda o `basedOn` da sua captura.

### O que ainda fica

- **Nada ao vivo**, como na seção 8.
- **Merge:** renomes não reescrevem texto de SQL ou JavaScript; um passo do Studio que o merge não sabe recolocar no fluxo
  (os dois lados inserindo passos que se ramificam no mesmo ponto) recusa o texto em vez de juntar; o casamento de partes
  sem identidade (casos, filtros) é por lugar e semelhança, e duas mudanças da mesma parte por lados diferentes são conflito
  (a entrega fica); a leitura guardada precisa estar no armazém que o processo do job vê (agora também a que o próprio job
  deixa: o `textSha` do recibo e o `nextBasedOn` dos dados).
- **Dados:** sem a leitura, a declaração que difere do módulo é recusada mesmo quando só a entrega mudou (sem a leitura não
  dá para saber); a edição pronta vem na recusa.
- **Mapeamento no O11:** o valor que a recusa sugere para um obrigatório é o vazio do tipo (`NullIdentifier()`, `""`, `0`);
  um tipo sem vazio conhecido sai como `<a value of its type>`; a bateria deixa de fora o destino com atributo de registro
  que tem obrigatórios próprios.
- **Fachada:** depois de uma mudança nas fontes que o builder do ODC compartilha (o leitor de fluxo), a primeira rodada do
  teste do servidor stdio (`mcp.test.mjs`) recompila o builder e falha pelo aviso que isso escreve; as rodadas seguintes
  passam (aconteceu aqui uma vez).
- **Suítes:** só os filtros acima e o Builder.Tests; não rodei as suítes inteiras do kernel nem a fachada inteira.

## 10. Os bloqueios da conferência (12/10/2026)

A conferência (`C:\t\tx\PROVA-AO-VIVO-TEXTO.md`) achou quatro regras do dono que o motor ainda não cumpria e frases do dono que
o classificador errava. Branch `feat/tx-bloqueios`, sobre `c4d71776`. As entradas da conferência (`C:\t\tx\verif\work`: `rules`,
`rules-o11`, `x`, `gs`) rodaram de novo com as CLIs da branch; o patch de cada recusa foi aplicado e o job rodou outra vez
(`C:\t\tx-bloq\proofs\final\summary.txt`).

| # | Antes | Agora | Prova (entrada da conferência) |
|---|---|---|---|
| B1 | JavaScript novo numa screen action aceito nas duas faixas | `FLOW_JAVASCRIPT_NOT_ISOLATED`; num fluxo de cliente, o patch leva o script para uma client action nova e a chama no lugar do nó; JavaScript existente continua editável | `Aprovar` (EscalaViva, ODC) e `LoadCop` (PastConflicts, O11): recusa com patch; job com o patch aceito, Verify limpo. `CarregarTipos` (JavaScript existente editado): aceito |
| B2 | T1 com `patch: null`; a List action só em `text`; T3 sem patch | T1/T2 e T3 (quando certo) com o patch do job conferido; `text` continua | `FiltrarAtivos`, `FiltrarFacetas` (actions novas), `PcAdvanceNaraOrder` (existente, T1 e T3): recusa com patch; com o patch, aceito e Verify limpo |
| B3 | a recusa da forma edição em 3 voltas; `HTML_SCRIPT` sem patch; `v-for` passava | uma recusa com tudo: `<script>`, `javascript:`, os 2 Visible, `v-for` (`HTML_FOREACH`), `JSONSerialize` (`HTML_JSON` e `FUNCTION_UNKNOWN`); uma lista de edições corrigida, conferida, nos problemas certos | `Cart` (GameStore): `v2` dá 7 problemas numa recusa; com o patch, sobram só os que nada corrige (`v-for` sobre `games`, que a tela não tem, e o JSON) |
| B4 | o patch do `HTML_FOREACH` trocava `{{ n }}` por `{{ Id }}`, que não compila | a linha vira `Nomes.Current`; o documento corrigido é compilado (com o Verify das expressões) antes de ser oferecido | `b1b`: o patch compila e o job é aceito; `b1`: o `v-for` sobre `itens` (inexistente) fica sem patch, os outros problemas têm o documento corrigido que compila |

### O classificador das rotas

Frases do dono que não dizem o tipo do elemento passam a ter rota (`text-routes.mjs`):
- um nome que parece palavra de família é nome: palavra com maiúscula escrita sem o acento que ela leva ("deixa **Acao**
  obrigatório"), palavra de parte com maiúscula ("o **Texto** da Nota"), palavra com maiúscula antes de "obrigatório"/"opcional";
- `campo`/`field` sem tela, formulário ou outra parte de tela é atributo ("adiciona o campo Observacao na QuoteAudit");
- o nome de uma action em CamelCase que começa por verbo é a action ("corrige a CalcularMediaAvaliacoes");
- `caracteres`, `obrigatório`/`opcional` nomeiam o dado; `devolver`/`retornar`, a lógica; `espaço`, `aviso`, `negrito`, a tela;
- verbos que faltavam: `deixa`, `aumenta`, `diminui`, `coloca`, `inclui`, `acrescenta`;
- continuam sem rota: registro de teste ("insere um produto de teste") e depuração ("debug GetCustomers").

As 6 frases da seção 6 da conferência e 13 parecidas estão no teste `the owner's way of writing...` de
`platforms/odc/facade/tests/text-routes.test.mjs`; as 160 do aceite, os 630 pedidos de operação e as 13 do roteiro continuam
certas.

### WIRED

Chave de verdade (seção 1): rota desligada perde a entrega no `ssam_discover` e no `ssam_map` (`continuations.edit: null`) e
tem a forma de escrita recusada (`TEXT_FORM_NOT_WIRED`) por `o11_deliver`, `studio_deliver` e `ssam_job`/`o11_job`, antes do
kernel. Teste: `WIRED is a switch...` em `text-routes.test.mjs`.

### Números

Medidos em 12/10/2026, ambiente isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`, autoridade, TEMP,
índice e fricção privados), a base `c4d71776` num worktree próprio e a branch no seu, comparados pelo nome das falhas:

| Suíte | Base `c4d71776` | Branch |
|---|---|---|
| Anvil.Tests filtrada (`Flow`, `Logic`, `Text`, `Ddl`, `Spec`, `ScreenHtml`, `Job`, `Preflight`) | 962 de 962 | 971: as 9 novas passam; a bateria LG2 do corpus caiu em 22 desfazimentos (abaixo) e passa depois da correção |
| Anvil.Tests.Odc filtrada | 345 de 345 | 353: as 8 novas passam; a bateria LG2 caiu em 16 desfazimentos e passa depois da correção |
| Depois da correção: `Flow`, `ScreenHtml`, `ScreenDocument`, `ScreenRecreation`, `HtmlPage` | — | O11 160 de 160, ODC 58 de 58 |
| Fachada (24 arquivos: `text-routes`, `discover*`, `discovery*`, `module-*`, `job-runner`, `o11-cycle`, `tool-routes`, ...) | 258 ok, 5 falhas | 260 ok, as mesmas 5 falhas (ambiente: capturas sem a chave da bridge e carimbos "proven-current" da O11) |

Baterias e pontos fixos do corpus, na branch: LG2 3.399 de 3.399 edições e desfazimentos (O11, 1 action em 6) e 1.724 de 1.724
(ODC); C2 676 de 676 (ODC) e a do O11 inteira; C1 no ponto fixo nas duas faixas; LG1, DL1 e DL2 iguais à base; B1 (recriação)
igual à base, com a mesma diferença conhecida (`FloodQuotes/PropertyCoverage`).

A bateria LG2 desfaz cada edição escrevendo o texto de antes; desfazer a remoção de um nó JavaScript escrevia esse nó de novo, e
a decisão 6 o recusava como JavaScript novo. O desfazer da bateria passa a action como a leitura a tinha
(`ModelSession.FlowRestore`, só da bateria, nunca de uma op): um nó JavaScript com o mesmo nome e o mesmo código volta como era.

### Lacunas desta etapa

- **Nada ao vivo**: as provas são as entradas da conferência, offline. A prova ao vivo do roteiro continua pendente.
- **Decisão 6**: "isolada" é a client action que só roda JavaScript (nós JavaScript, comentários e assigns para as saídas). Num
  fluxo de servidor não há patch (servidor não roda JavaScript).
- **T1 em fluxo de cliente**: a condição do `ListFilter` vai com os atributos do item (a regra do time); o Verify aceita, mas a
  semântica em execução no O11 de cliente não foi provada ao vivo.
- **T3**: só o caso certo em fluxo de servidor tem patch (uma fonte, no máximo uma linha, citado só no laço). O resto continua
  com a recusa do candidato e a correção escrita. O aggregate lido antes do laço traz todas as linhas que os filtros
  independentes deixam: é a correção do padrão do time, não uma otimização.
- **Forma edição, `v-for`**: o plano lê nomes, não expressões; o patch só sai quando a fonte é dado da página e a linha lê
  atributos que o módulo tem. Variável nova de lista numa edição não é escrita pelo escritor da edição (limite anterior).
- **WIRED** vale para o MCP; a CLI do desenvolvedor aceita as quatro formas.

## 11. A revisão dos bloqueios (12/10/2026)

A revisão da branch (casos adversariais em `C:\t\tx-bloq\rev\adv`) achou sete pontos em que o motor ainda não cumpria as
regras do dono. Cada um tem teste e foi provado de novo com as CLIs da branch sobre as bases da conferência (EscalaViva ODC,
PastConflicts O11, GameStore O11), cada patch aplicado e o job rodado outra vez (`C:\t\tx-bloq\fix2\adv-summary-final.txt`,
`C:\t\tx-bloq\fix2\proofs\summary.txt`).

| Ponto | Antes | Agora | Prova |
|---|---|---|---|
| foreach sobre a linha de um aggregate (`Element=GetX.List.Current.Entidade`) | aceito nas duas faixas | T1/T2 recusado; patch `ListFilter` + `ListAppendAll` (O11 converte a linha; ODC `mapTo {  }` para a lista da entidade); fontes de aggregate de tela e tipo de lista da tela vêm do módulo | p4 (O11), e2 (ODC, screen action), e3 (ODC, server): recusa com patch, patch aceito |
| `javascript:` num button | o patch tirava o clique e o Verify recusava o button sem On Click | Button e Link exigem o clique: sem patch, correção escrita; o documento corrigido é compilado com todo erro do Verify sobre o que escreve, e a correção que deixa um widget inválido sai | h3, o1 (forma documento), h4 (forma edição), b1 com as sobras corrigidas: patch do Visible e do `<script>`, o button nomeado à mão, aceito |
| patches T2 de mapeamento na ODC | `mapTo {  }` vazio para lista de valores; campos na ordem dos assigns, que a plataforma lia como segundo mapeamento | `mapTo { Value: Campo }` para lista de valores; campos na ordem dos atributos do registro; a local montada sai com o laço | e6, e7: patch aceito e lido de volta exato |
| recusa de regra do dono escondia o Verify do resto | o erro da outra action (ou do outro elemento) vinha na segunda volta | rodada do patch: o job com os patches roda numa cópia da base; o que nenhum patch mudou entra na mesma recusa (`afterPatch`), o que o patch causou tira o patch | e12, e13 (logic), h5 (edição html): uma recusa com a regra e o Verify |
| nome da client action do patch do B1 | colidia com uma screen action da tela (`NAME_COLLISION`) | o nome evita toda action do módulo e das referências, tela, bloco e fluxo | e1: `AtualizarVisual2`, aceito |
| T2 por mapeamento no O11 | aceito | recusado com a correção escrita (mapeamento do `ListAppendAll` no Studio) | p8, p9, p5 |
| `v-for` sobre fonte composta na forma edição | sem patch | saída de data action da página (`CartCards.Cards`) e aggregate de tela (forma longa) viram `list` com a linha `Fonte.Current` | h1, h1b: patch, sobram só os problemas sem correção |

Também: o Verify de um texto de logic aponta o texto (`/ops/i/data/flow/j`) e o de uma edição html aponta a op; um button novo
que chama uma screen action fica com as validações que a plataforma lhe dá (`ValidateAndContinue`), em vez de recusar a
edição (`HTML_EDIT_NOT_APPLIED`).

Suítes filtradas (`Flow`, `Logic`, `Text`, `Ddl`, `Spec`, `ScreenHtml`, `Job`, `Preflight`), ambiente isolado: Anvil.Tests 978 de
978 (as 971 de antes e 7 novas), Anvil.Tests.Odc 358 de 358 (as 353 de antes, a falha de ambiente de antes passou, e 5 novas),
comparadas pelo nome com a rodada anterior: nenhuma falha nova. As baterias e os pontos fixos do corpus estão nelas.
`ScreenDocument`, `ScreenRecreation` e `HtmlPage`: O11 42 de 42 (com as 2 novas), ODC 1 de 1. O teste do e1
(`AScriptMovedOutOfAScreenActionTakesANameNoActionOrScreenHas`, a tela Login da fixture reativa: `Login` é tela e screen action,
o patch cria `Login2`) passa; com a CLI de `f9d81a8e` o mesmo job dá o patch com `client action Login`.

## 12. Terceira junção: os bloqueios sobre os limites (branch `feat/texto-ssam-2`)

Feita em 12/10/2026: merge de `feat/tx-bloqueios` (`4a5b03ad`, seções 10 e 11) em `feat/texto-ssam-2` (`a7c0f1a4`, seções 7 a
9). Nada ao vivo: sem Studio aberto, sem MCP `ssam`, sem push. Os dois lados ficam: dos bloqueios, B1 a B4, o classificador das
rotas, o `WIRED` como chave, a autovalidação dos patches e as correções da revisão; dos limites, o merge de 3 vias da lógica e
dos dados, o mapeamento de registros no O11 e as actions de tela, bloco e dados nascidas do texto.

**Conflitos** (9 arquivos), resolvidos juntando os dois lados: `FlowProblem` fica com `Data` (a edição pronta, o texto juntado,
os conflitos do merge) e com `Corrected`/`Added`/`Fields`; `FlowDiff.Compute` leva o texto, as correções e o que o módulo diz
(`IFlowTypes`) e também o dono da action nova; em `Verbs.Flow.cs` o `FlowPlan` tem `Merged`, `Shell` e `RebasedOn`, a recusa
passa por `FlowTextForm.Problem` (que copia `Fields` e `Data`) e `ModelFlowTypes` vê o dono sob o qual uma action nova nasce;
o preflight (`JobPreflight.cs`) é o dos bloqueios, com os patches; `Verbs.ScreenDocument.cs` desfaz as cascas e confere o
documento corrigido (B4); os testes e estas duas páginas juntaram as duas listas.

**Correções da junção:**
1. **T1/T2 no arquivo novo, com o mapeamento do O11.** A regra saiu de `FlowDiff.cs` para `FlowDiff.ForEach.cs` (o
   classificador dos bloqueios). O mapeamento campo a campo agora tem patch nas duas faixas, com os campos na ordem do registro;
   no O11 o patch nomeia todo atributo obrigatório do destino (`IFlowTypes.MandatoryOf`, lido do módulo como
   `RecordMappings` lê: o identificador como `NullIdentifier()`); outro obrigatório que o laço deixa como a local tinha fica na
   correção escrita. A lista de valores no O11 continua com a correção escrita.
2. **Conflito de verdade, decidido pela regra do dono.** Nos limites, o laço que copia alguns campos para o mesmo tipo, que lê
   a própria local ou que a usa fora do laço era um For Each permitido (`MapKeepsMeaning`). Nos bloqueios, a decisão 5 diz que
   For Each novo que só monta e anexa é sempre recusado. Fica a decisão 5: os três casos são recusados com a correção escrita e
   o motivo, sem patch (`FlowEditTests.TheMapRuleIsOfferedOnlyWhereThePatchKeepsTheLoopsMeaning`).
3. **O texto juntado passa pelas regras do dono.** Um texto escrito sobre uma leitura antiga é juntado em 3 vias e julgado
   como um texto (T1/T2, JavaScript novo, T3 com o escape, nomes, o que o módulo diz). A recusa traz o texto juntado
   (`merged`), e o patch manda esse texto corrigido com o `basedOn` de agora, sem juntar de novo; o job do patch é aceito com
   o que o Studio fez mantido. Cenário novo nas duas faixas:
   `FlowApplyScenarios.AnOlderReadThatBreaksARuleIsRefusedWithThePatchOfTheMergedText`.
4. **A conversão da linha na ODC.** Escrito pelo patch, o `mapTo {  }` de uma linha de aggregate é a conversão que a plataforma
   faz sozinha, e a leitura (desde os limites, `FlowExtract`) o deixa de fora: a action relida diz `SourceList=Filtro.FilteredList` nas duas faixas
   (`TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest`).

**Checagens rápidas** (ambiente isolado, sem as baterias do corpus): as duas CLIs e os dois projetos de teste compilam;
Anvil.Tests 124 de 124 (`FlowEditTests` 31, `FlowApplyTests` 22, `FlowMergeTests` 19, `DdlMergeTests` 12,
`FlowMappingTests` 9, `ScreenDocumentTests` 13, `ScreenHtmlEditTests` 11, `ScreenHtmlEditJobTests` 7 sem o corpus);
Anvil.Tests.Odc 93 de 93 (`FlowEditTests` 31, `FlowApplyOdcTests` 19, `FlowMergeTests` 19, `DdlMergeTests` 12,
`ScreenHtmlEditTests` 11, `ScreenHtmlEditBatteryOdcTests` 1 sem o corpus); fachada 105 de 105 (`text-routes`, `module-flow`,
`module-map`, `job-runner`, `job-patch`, `discover-tools`, `o11-cycle`). As baterias e os pontos fixos do corpus rodam depois
deste commit, com as CLIs da junção.

**As provas da conferência e da revisão, de novo com as CLIs da junção** (59 jobs sobre EscalaViva, PastConflicts e GameStore,
os textos de lógica rebaseados na leitura da junção, cada patch aplicado e o job rodado outra vez: 40 rodadas de patch, 30
aceitas; `C:\t\tx41\pr\summary.txt`): o mesmo resultado da revisão em todos, menos um, que melhorou como devia: o `p9` (O11,
local montada campo a campo e anexada) era recusado só com a correção escrita e agora vem com o patch do mapeamento, aceito.

## 13. Correção 1 da terceira junção (12/10/2026)

As baterias da terceira junção (`5a606386`) e as três revisões dela acharam falhas e achados. Esta etapa corrige todos, cada um
com um teste que falha antes e passa depois (rodados contra uma cópia de `5a606386` com os testes novos: 12 de 14 falham no
O11 e 12 de 12 na ODC; os 2 que passam no O11 são de achados só da ODC). Nada que o modelo não tocou se perde; num conflito
de verdade a entrega ganha e é listada.

| Falha ou achado | Correção | Teste |
| --- | --- | --- |
| Merge: o JavaScript que o Studio removeu e a entrega mudou volta com id novo (`+m1`) e era julgado JavaScript novo (`FLOW_JAVASCRIPT_NOT_ISOLATED`): o lado da entrega recusado | `FlowMerge.Result.Rewritten`: os ids dos elementos da leitura que o merge escreve de novo; `FlowDiff` não os julga como novos (decisão 6, T1/T2, T3) | `FlowMergeTests.AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsTheActionsOwn`; `AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain` (duas faixas) |
| Bateria do merge: o desfazer reescrevia o JavaScript removido como novo, recusado, e o recarregamento cortava os casos da action (5 recargas no shard) | `FlowMergeBattery.Undo` com `FlowRestore = @base`, como a `FlowBattery` | `TheMergeBatteryUndoesAndMergesAnExistingJavaScript` (duas faixas: 0 recargas, todos exatos) |
| Criação: donos cujas screen actions todas rodam JavaScript perdidos (O11 403 < 408, ODC 109 < 110) | a `FlowCreateBattery` cria o dono pelo patch verificado da recusa (a client action nova primeiro, depois o texto corrigido; os dois relidos como seus textos; `rules` conta `patched CODE`); o patch escreve a chamada como o leitor (`Acao(Nome)` quando o valor é o próprio nome) | `FlowBatteryCorpus.RunCreatePatched`: `DCIPS_Staff_Common` (O11) e `FloodQuotes` (ODC) |
| Dados: dois textos de dados de um job escritos sobre a captura: o segundo desfazia o primeiro sem merge | a op guarda o texto de dados do início do job; um texto sobre a captura é juntado em 3 vias com ele quando uma op anterior mudou os dados | `TwoDataTextsOfOneJobOnTheCaptureKeepEachOther` (duas faixas) |
| Lógica: linha vizinha mudada pelo Studio voltava para a leitura (tratada como "as mesmas linhas") | conflito só em sobreposição de verdade (ou inserção no mesmo lugar); vizinhas ficam as duas | `FlowMergeTests.LinesNextToEachOtherChangedOneByEachSideAreBothKept` |
| Caso de switch movido pelo Studio e mudado pela entrega virava dois casos, com um conflito falso | a parte que um lado só moveu é a mesma parte | `FlowMergeTests.ACaseTheStudioMovedAndTheDeliveryChangedIsOneCase` |
| Renome de um lado reescrito no valor de campo de `mapTo` que lia o atributo da origem (as ligações trocavam em silêncio) | o merge tipa a origem pelo módulo: o nome que é atributo fica; o renomeado entra; o que cairia num atributo é recusado (`FLOW_RENAME_CAPTURED`, com a action de agora); sem tipo nenhum valor de campo é reescrito | `FlowMergeTests.ARenameIsReadIntoAMappingValueOnlyWhereItNamesTheRenamedElement`; `AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute` (duas faixas) |
| `FLOW_RENAME_CAPTURED` não tipava saída de chamada nem membro de registro | `SourceAttributes` tipa `GetX.Saida` (pela action chamada), a lista de um SQL, e membros registro; o que o módulo não tipa conta com todo nome de atributo do módulo (recusa conservadora com nome livre) | `AMappingFromACallsOutputIsTypedThroughTheAction` (duas faixas) |
| Verbo cru `rename` sem a checagem de captura | a mesma checagem no verbo (parâmetro ou local de uma action, ou variável de tela/bloco nas suas actions) | `ARawRenameAMappingWouldReadAsAnAttributeIsRefused` (duas faixas) |
| Renome de parâmetro de nó SQL/JavaScript pelo texto: `KeyNotFoundException` | os argumentos do nó comparados com o renome aplicado: o argumento segue com o nome novo | `FlowEditTests.ANodeParameterRenamedByTheTextKeepsItsArgument`; `ANodeParameterRenamedByTheTextKeepsItsArgument` (duas faixas); bateria `--kinds noderename` |
| ODC: editar um `mapTo` existente pelo texto: `FLOW_NOT_EXACT` (a conversão antiga embrulhava o novo) | a ODC guarda o mapeamento numa conversão própria (`ValueTypeConversion`, como o O11): o kernel tira a que há e escreve o valor inteiro pelo setter; um valor simples sobre uma conversão também a tira (a plataforma refaz a automática) | `AnExistingMappingIsEditedByItsText` (duas faixas); bateria `--kinds mapedit` |
| ODC: literal de registro guardado como texto que a plataforma não lê, relido como exato; na atribuição, asserção sem código | o literal escrito pelo setter, com o tipo do argumento, depois dos outros argumentos (ordem das entradas da action chamada: a ODC não guarda `Arguments` em ordem); valor que fica `NotParsedExpression` é recusado na escrita (`FLOW_NOT_EXACT`); literal numa atribuição recusado no plano (`FLOW_VALUE_RECORD_LITERAL`) | `ARecordLiteralIsWrittenParsedAndOnlyAsAnArgument` (ODC, 8 de 8 rodadas) |
| As baterias julgavam só o texto | `BatteryVerify`: um caso em cada 25 (`FLOW_BATTERY_VERIFY`) só é exato sem erro novo do parser sob a action (os outros erros que uma edição sintética traz são dela, não do motor); `verified`/`verifyRefused` nos totais | `BatteryVerifyOdcTests.AValueKeptUnparsedIsANewVerifyErrorUnderTheAction` |
| O11: mapeamento da saída de uma chamada criada no mesmo texto: `FLOW_MAPPING_TYPES` | o valor era lido com o escopo da action de antes do nó: os caches de escopo caem e o valor é lido de novo | `AMappingFromACallsOutputIsTypedThroughTheAction` (O11) |
| ODC: patch T2 para lista de entidade sem o `Id` obrigatório (patch retido) | `MandatoryOf` nas duas faixas (o identificador sempre) | `TheT2PatchIntoAnEntityListNamesItsIdentifier` (duas faixas) |

A bateria do merge e a LG2 não embrulham mais um literal de registro em parênteses (como já não embrulhavam um `mapTo`): na
ODC isso não é expressão que o parser lê, e passava como exato só porque a bateria julgava o texto.

**Checagens rápidas** (ambiente isolado; as baterias do corpus O11 rodam de novo depois): Anvil.Tests 139 de 139 e
Anvil.Tests.Odc 109 de 109 nos filtros da etapa 12 (com os testes novos), mais `BatteryVerifyOdcTests` e os testes de criação
pelo patch dos dois corpora. Nos módulos tocados, com as CLIs desta etapa: merge O11 sem recarga e todo caso exato
(SS360_Backoffice 29 de 29, Haiku_UI-live 79 de 79, DCIPS_Staff_Mortuary 75 de 75, DCIPS_Staff_Admin 264 de 264;
`SearchDebounce` sozinho 7 de 7, eram 5 com 1 recarga); criação O11 (DCIPS_Staff_Admin 48, DCIPS_Staff_Common 13,
DCIPS_Staff_Reporting 23, OfficePetMobile 20, todas exatas: os números da `a7c0f1a4` por módulo, 5 donos pelo patch); LG2 O11
Haiku_UI-live 52 de 52; `noderename` O11 29 de 29 (Haiku_CS, DCIPS_Case_CS) e ODC 13 de 13 (FloodQuotes); `mapedit` ODC 7 de 7;
merge de dados Haiku_CS 16 de 16. O corpus ODC inteiro: LG2 1.724 de 1.724 (o piso), merge 2.397 de 2.397 (997 disjuntos e
1.400 sobrepostos, 0 recargas), criação 114 de 114 (110 screen e 4 data actions, os pisos; 1 dono pelo patch); a amostra do
Verify, 176 casos, nenhum erro novo do parser.

## 14. Correção 2 da terceira junção (12/10/2026)

A rodada 2 das baterias (sobre `b5c28f8e`) e as três revisões dela acharam uma falha de bateria, três achados altos e oito
médios. Esta etapa corrige a falha, os três altos e os médios rápidos, cada um com teste (unitário nas duas faixas e, onde o
motor escreve, um job real nas duas). A linha 626 da seção 13 muda: em código, linhas vizinhas mudadas uma por cada lado
continuam as duas, mas agora são listadas (`kept: both`).

| Falha ou achado | Correção | Teste |
| --- | --- | --- |
| Criação O11 (DCIPS_Staff_Reports, `CustomDashboard.LoadDashboardTx1`): 586 criadas, 585 exatas. Dois For Each viram dois `ListAppendAll` sem nome; o escritor nomeia o segundo `ListAppendAll2` e o leitor o imprime como rótulo | o patch dá ao `ListAppendAll` o nome livre da action (o primeiro sem nome; o segundo `ListAppendAll2`, como o Studio nomeia uma cópia), reservado entre os patches do mesmo texto | `FlowEditTests.TwoLoopsArePatchedWithANameEachAndALoopWithALimitHasNoPatch`; `TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch` (duas faixas) |
| O mesmo caso: os dois laços tinham `max 8` e `max 10`; o patch "certo" anexava a lista inteira | laço com `max` ou `start` não tem patch certo (a correção escrita diz por quê); segue recusado (T1/T2) | os mesmos |
| Alto: partes de identidades diferentes casadas pelo lugar: o valor da entrega caía na variável ou no parâmetro do Studio, com o conflito dizendo "kept: delivery" (A1, A1b, A5, E1) | `Match` estrito: duas partes de identidades diferentes nunca são casadas (o argumento só quando o lado apontou a chamada para outra action) | `FlowMergeTests.AnAssignmentOfAnotherVariableIsNeverMergedIntoTheDeliverysValue`; `AMergeNeverPutsOneSidesValueUnderTheOthersName` (duas faixas) |
| Alto (resto do mesmo): chamada que o Studio apontou para outra action e a entrega mudou ia para a outra action com o argumento da entrega, ou caía em `KeyNotFoundException` (A6, E3) | a chamada inteira da entrega (action e argumentos), listada como `call` | `FlowMergeTests.ACallTheStudioPointedElsewhereAndTheDeliveryChangedIsTheDeliverysWholeCall`; o mesmo job real |
| Alto: sobras casadas pela semelhança na ordem da leitura: o filtro ou caso que o Studio mudou sumia quando ele removeu outro (A2b, A4, E2) | o par mais parecido primeiro | `FlowMergeTests.APartTheStudioChangedIsNotLostWhenItRemovedAnotherOne`; o mesmo job real |
| Variante (A3): mesmo número de sobras casado pelo lugar: o filtro que o Studio pôs no lugar de outro sumia como "conflito" | parte sem identidade que a entrega mudou pouco e o Studio trocou por outra pouco parecida: do Studio removida e acrescentada, as duas ficam (a da entrega listada) | `FlowMergeTests.AFilterTheStudioReplacedStaysBesideTheOneTheDeliveryChanged` |
| Alto: atributo renomeado (texto de dados ou verbo cru) para o nome de um parâmetro que um `mapTo` daquele registro lê: o valor passava a ler o atributo, com ponto fixo dito e sem recusa (o-dr, d-dr) | o `rename` de atributo de entidade ou estrutura procura, nas actions em cujo escopo há um elemento do nome novo, um `mapTo` daquele registro (a origem tipada com os mesmos atributos; sem tipo, um valor que cita o atributo) com um valor de campo que lê o nome novo: `FLOW_RENAME_CAPTURED` com nome livre | `AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused` (duas faixas, verbo cru e texto de dados) |
| Médio: uma sobreposição de verdade levava junto a linha do Studio que só encostava no grupo (A7) | o grupo só junta hunks que dividem uma linha da leitura, ou inserções no mesmo ponto | `FlowMergeTests.ATrueOverlapTakesOnlyItsLinesAndNeighbouringCodeIsListed` |
| Médio: SQL/JS vizinhos mudados um por cada lado ficavam os dois sem aviso (JS com variável indefinida) | em código, ficam os dois e são listados (`kept: both`); fora de código (descrição) só ficam | o mesmo; `LinesNextToEachOtherChangedOneByEachSideAreBothKept` (agora lista) |
| Médio: o Studio troca a origem de um `mapTo` e a entrega muda ou acrescenta um campo: juntados em silêncio, o campo lendo outra coisa (A8, sw2 da r1) | origem diferente nos dois lados finais: o mapeamento inteiro da entrega, listado | `FlowMergeTests.AMappingOneSidePointedAtAnotherSourceIsMergedWhole` |
| Médio: `drop` de um elemento criado depois da leitura caía sem lista (D1) | a regra sem leitura: `DDL_BASE_UNKNOWN` com a declaração de agora | `DdlMergeTests.ADropOfAnElementCreatedAfterTheReadIsRefusedAsWithoutTheRead` |
| Médio: alias de aggregate renomeado para o nome de um local que o próprio aggregate lê (e3) | `FLOW_RENAME_CAPTURED` com nome livre, quando as expressões da leitura daquele aggregate citam o nome | `FlowEditTests.AnAliasOnTheNameOfAnElementTheAggregateReadsIsRefused` |
| Médio: ODC, `mapTo` ou literal sem atributo obrigatório só recusado pelo Verify (d-p8, d-p9, d-l4) | no plano da ODC: `FLOW_MAPPING_TYPES`, com o patch quando o valor é certo (`Id: NullIdentifier()`) | `FlowEditTests.AMappingThatLeavesAMandatoryAttributeEmptyIsRefusedInTheODCPlan`; `AValueThePlatformWouldRefuseIsRefusedInThePlan` (duas faixas) |
| Médio: O11, literal de registro num argumento relido como exato e só recusado pelo Verify (o-l1) | no plano do O11: `FLOW_VALUE_RECORD_LITERAL` com a correção escrita | `FlowEditTests.ARecordLiteralIsRefusedInTheO11PlanAndTakenAsAnODCArgument`; o mesmo job real |
| Médio: renomes de parâmetros um a um: trocar dois nomes, ou remover A e renomear B para A, falhava com "clashes" (k2, k3) | os renomes saem numa ordem em que nenhum toma um nome que outro ainda tem; ciclos e o removido passam por um nome livre; as expressões lidas com todos os renomes de uma vez | `FlowEditTests.NamesThatTradePlacesAreRenamedThroughAFreeName` |

**O que fica** (não feito nesta etapa): (b) e (c) do achado alto do renome de atributo, para o renome feito no Studio (fora do
SSAM): a leitura ainda diz ponto fixo quando um valor de campo nomeia um elemento da action com o nome de um atributo da
origem, e o merge não trata isso como captura (precisa comparar as ligações da expressão no modelo, não só o texto); trocar
o nome de duas actions de textos diferentes do mesmo op (o-c2) ainda falha com o choque de nomes.

## 15. A primeira resposta basta: o texto no pacote, o ambiente e as páginas (branch `integracao/24-1`)

Feita em 12/10/2026 sobre a junção 24.1 (`50815b9c`). Nada ao vivo: sem Studio, sem MCP `ssam`, sem push.

**Por quê.** No reteste do dono (Codex, `FolhaPonto_CS`, 13:26–13:37 UTC):
- as tabelas levaram 73 s, os mesmos de antes;
- as 9 server actions levaram 6 min 28 s: cerca de 3 min de exploração (16 rodadas de leitura, 129 KB lidos), cerca de 2 min
  escrevendo um construtor de job em JavaScript de 23 KB, uma recusa e um patch de 7 KB.

O modelo nunca usou o texto: o pacote (`packet:true`) só trazia as formas JSON. Dez chamadas foram para achar um componente de
PDF, e cinco `ssam_evidence` para paginar uma listagem de 85 KB.

**1. O texto no pacote** (`text-packet.mjs`, seção `text` logo depois de `module`). Toda intenção que cria ou muda dados, lógica
ou telas recebe, na primeira resposta:
- **A leitura exata**, ou por que não precisa:
  - `ssam_map` com `view` `ddl`, `flow` ou `html`, sobre a captura do pacote e com o `expectedSourceSha256` dela;
  - ou "o módulo não tem entidades/actions/telas: escreva do zero";
  - ou "criação não precisa de leitura", com a leitura pronta para quando for mudar.
- **A chamada de entrega exata** (`o11_deliver` ou `studio_deliver`), com o módulo e as ops das formas de texto na ordem do
  job: declarações de dados, as exceções de usuário que os textos levantam, o documento da tela e os textos das actions.
- **Por forma**: a gramática (uma linha por construção), o cartão do contrato do índice (`spec.ddl`, `logic.flow`,
  `html.document`) e um exemplo provado.
- **As regras do dono**, uma linha cada.

Mais detalhes:
- Actions novas levam o texto de dados junto (estruturas e site properties do mesmo job).
- O classificador lê "tabelas" sem tela como entidades e aceita "registro" num pedido de actions.
- Os exemplos ficam em `platforms/odc/facade/text-examples.json`. Eles são provados nas duas faixas por
  `FlowApplyScenarios.ThePacketExamplesApplyInOneJob` e `ThePacketScreenExampleAppliesInOneJob`: um job só, relido igual ao
  texto.
- Onde a rota vale, o JSON que ela substitui sai do pacote: as capacidades cobertas viram uma linha (`inText`, com o `expand`
  da forma JSON), a gramática dos passos JSON sai, o exemplo JSON vai por referência e as lições do time vão sem os exemplos
  JSON.

**2. O que o ambiente oferece** (`environment-components.mjs`). Cobre PDF, Excel, e-mail, arquivos, ZIP, imagens, QR, hash,
Word e SMS. Numa resposta só vêm as extensões e os componentes Forge instalados que o nome ou as actions dizem, cada um com as
actions públicas em uma linha de assinatura, a op `reference` e como o texto as chama.
- Fontes: a listagem de produtores, o XIF de cada extensão e o digest de cada eSpace publicado.
- Cache por ambiente em `.local/components/<host>.json`, pela `signatureHash` de cada produtor. Sem Studio, a resposta vem do
  cache da última listagem.
- Vai no pacote quando a intenção nomeia a necessidade (seção `environment`). No O11 também é uma intenção direta:
  `ssam_discover {lane:"o11", intent:"o que tenho no ambiente para gerar PDF"}`.

**3. As páginas** (`paged-answer.mjs`). Uma resposta acima do teto traz inline:
- todo array grande como tabela, com todas as linhas;
- sem as colunas opacas (chaves, hashes, GUIDs) quando não cabe inteira;
- o objeto em volta;
- o `outline` do que ficou fora;
- uma chamada só para o que falta (`ssam_evidence {table:true}`, até 64 KB).

### Números (offline, sobre as capturas e as listagens do reteste)

| | Antes (reteste) | Agora |
|---|---|---|
| Tabelas: rodadas de leitura até escrever | 3 (71,9 KB lidos) | 1 (pacote de 7,9 KB com as palavras do dono; 12,8 KB com as do modelo) |
| Tabelas: caracteres escritos | 6.840 (job JSON) | 5.664 (as mesmas tabelas em ssam-ddl/1) |
| Tabelas: tempo do modelo pela ANALISE (10 s/rodada, 8,2 ms/caractere) | 86 s | 56 s |
| Actions: rodadas de leitura até escrever | 16 (129 KB lidos) | 1 (pacote de 24,7 KB com `text` e `environment`), mais 1 se o modelo pedir assinaturas de built-ins que a intenção não nomeia |
| Actions: caracteres escritos | 30.241 (construtor de 23 KB + patch de 7 KB) | cerca de 21.500 (texto ≈ 0,93 do JSON neste domínio) + o patch, se houver recusa |
| Actions: tempo do modelo pela ANALISE | 408 s | 186 s sem recusa, 245 s com o mesmo patch |
| Listagem de produtores (85 KB) | 5 chamadas `ssam_evidence` | 0: 452 linhas inline (Name, Kind, IsSystem; 17,9 KB) e 1 chamada para as chaves |

O ganho das actions é de leitura. A escrita fica perto do que era: o texto de lógica tem quase o tamanho do JSON (21.092 contra
20.041 bytes no pedido de 10/10; 23.958 contra 25.837 nas 7 actions de `FolhaPonto_CS`).

## 16. Os achados abertos das revisões, corrigidos (24.1, 12/10/2026)

Os verificadores das rodadas 1 e 2 (`C:\t\tx41\ACHADOS-VERIFICADORES-R1-R2.json`) deixaram em `566ce568` seis achados altos e
seis médios abertos (as regras do dono, que nunca tinham chegado às correções, e dois de ida e volta). Esta etapa corrige
todos, menos o classificador das rotas (o dono vai renomear a funcionalidade; ele volta com os nomes novos). Cada correção tem
um teste que falha em `566ce568` e passa aqui, nas duas faixas onde vale. Nada que o modelo não tocou se perde; num conflito de
verdade a entrega ganha e é listada; onde há duas leituras, a recusa vem com a edição pronta, nunca uma escolha calada.

| Achado | Antes | Agora | Teste |
| --- | --- | --- | --- |
| Alto: isenção `Rewritten` do merge | o Studio apagava um nó (um assign, uma mensagem) e a entrega punha no mesmo `@id` um JavaScript ou um For Each T1: o merge o escrevia de novo como "da action", e as regras de elemento novo não o julgavam (O11 e ODC) | só fica isento o elemento que a entrega escreveu como o mesmo tipo de nó que a leitura tinha (o JavaScript existente que a entrega mudou continua dela); outro tipo no `@id` é novo e é julgado; o conflito diz o que a leitura tinha ("MessageNode of the read (the delivery writes ...)") | `FlowMergeTests.AnotherKindOfElementOnTheIdOfANodeTheStudioRemovedIsJudgedAsNew` (duas faixas) |
| Alto: a op `logic` em JSON pulava a decisão 6 e o T1/T2 | `data.actions` com um nó JavaScript numa client action que faz mais, ou um `foreach` que só filtra para a lista: aceitos nas duas faixas | depois das ops, como o `QUERY_IN_LOOP`, cada action que uma op JSON declarou é lida do modelo candidato e os nós que a op escreveu novos passam pelas mesmas regras (`FlowDiff.NewElementRules`): `FLOW_JAVASCRIPT_NOT_ISOLATED` e `FLOW_FOREACH_LIST_ACTION` na mesma recusa, com o ponteiro da action (e do passo, quando ele tem nome) e a correção escrita; o T1/T2 traz as linhas da List action (`text`). O que a action tinha antes de um `replace` (JavaScript de mesmo nome e código, For Each sobre a mesma lista) é dela. A forma JSON tem um escape, só para T1/T2: `"allowForEach": {"why": "<15+ caracteres>"}` na op aceita o laço e o lista em `highWarnings` (`FLOW_FOREACH_LIST_ACTION_ALLOWED`, com o motivo), nunca calado; a forma texto não tem escape e o JavaScript novo não tem em nenhuma. Os 13 jobs de prova antigos que montam lista com For Each em JSON (5 do O11, 8 exemplos da ODC) levam esse escape com o motivo | `FlowEditTests.TheNodesAnotherFormWroteNewAreJudgedByTheSameRules`; `FlowApplyScenarios.TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules` (duas faixas: O11 em `mobile-ui`) |
| Alto: `WIRED` desligado não segurava job composto nem html com `components` | `textFormOf` devolvia nulo quando havia `components`; `textFormRefusal` não abria `{jobs}`: o kernel rodava | a forma segue a ordem do kernel (pai, edição, documento; `components` só depois); um composto é julgado nas partes (`partReader` lê `job:<nome>` e caminhos ao lado do job); uma parte que o servidor não lê, com rota desligada, é recusada (`TEXT_FORM_NOT_WIRED`, ponteiro `/jobs/<i>`) | `text-routes.test.mjs`: `WIRED holds a composite job and an html op that also carries components` |
| Alto: edit html anterior engolido por um posterior | o edit #0 punha `os-Visible` em `w9`, o #1 reescrevia o pai com `w9` dentro: aceito, o Visible sumia (na ordem inversa já era `HTML_EDIT_OVERLAP`) | depois de juntar, todo edit cujo elemento sumiu do texto junto com a subárvore de outro é `HTML_EDIT_OVERLAP`, nas duas ordens, citando o edit externo; o merge de 3 vias com uma leitura (`ScreenHtmlMerge`) também não junta mais esses edits (achado na prova `m1`: a junção engolia o Visible), e o plano os recusa | `ScreenHtmlEditTests.AnEditInsideAnElementALaterEditWritesAgainIsRefusedInEitherOrder` (duas faixas) |
| Alto: script novo por `ext:`, `on*` com maiúscula, `iframe src` com `{{ "javascript:..." }}` e `srcdoc` | aceitos nas formas edição e documento | L5 julgado pelo que o atributo é no navegador (`ScreenDocument.ScriptAttribute`): `ext:on*` e `on*` em outra caixa (o navegador lê sem caixa) qualquer que seja o valor, `srcdoc`, e URL `javascript:`/`vbscript:` literal ou como constante de uma expressão. `HTML_SCRIPT` com o patch que tira (ou põe de volta o que a leitura tinha), na edição, no preflight de elemento novo e no documento | `ScreenHtmlEditTests.AScriptByExtAnotherCaseAnExpressionUrlOrSrcdocIsRefusedWithItsPatch` (duas faixas) |
| Alto: atributo renomeado no Studio sobre o nome de um parâmetro que um `mapTo` lê | (b) a leitura imprimia `Key: Prefix + Code` e dizia ponto fixo, mas o modelo ligava `Prefix` ao parâmetro e o texto relido o ligaria ao atributo; (c) uma entrega da leitura antiga era juntada e escrita, e o valor passava a ler o atributo | (b) o leitor de fluxo olha as ligações do mapeamento no modelo (as duas faixas guardam o mapeamento em `ValueTypeConversion`, cada campo uma expressão com as suas referências: `KernelModelReader.MappingCaptures`): um campo ligado a um parâmetro, local ou variável com o nome de um atributo da origem torna o nó opaco (lido como está, nunca escrito de volta pelo texto); (c) no merge, um valor de mapeamento que a entrega escreveu novo, sobre a leitura antiga, e que cita um elemento da action com o nome de um atributo da origem agora (o módulo tipa a origem) tem duas leituras: `FLOW_RENAME_CAPTURED` com a action de agora como edição pronta | `FlowApplyScenarios.AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged` (duas faixas; o "Studio" é um `set Name` cru, que nenhuma checagem de renome vê) |
| Médio: Visible com outra caixa | `OS-VISIBLE`/`Os-Visible` gravados como atributo inerte (a condição sumia); `os-visible` falhava no setter sem patch e prendia os patches dos outros | toda variante é o Visible novo: `HTML_VISIBLE` com o patch do If (edição e documento; o compilador do documento lê `os-visible` como Visible), junto com os patches dos outros problemas | `ScreenHtmlEditTests.AVisibleInAnotherCaseIsTheNewVisibleWithItsIfPatch` (duas faixas) |
| Médio: T1/T2 com `ListInsert` no fim | aceito | `ListInsert` com `Position = <Lista>.Length` é o append do T1/T2 (patch da List action); em outra posição não é append | `FlowEditTests.AListInsertAtTheEndOfTheListIsTheAppendOfT1AndT2` (duas faixas) |
| Médio: op logic antes do edit html da mesma tela | `HTML_BASE_CHANGED` sem patch quando a store não guardava a leitura (num job misto, só na segunda recusa) | no começo do job o kernel lê as telas que os edits escritos sobre a captura do job nomeiam, quando uma op anterior escreve; o edit é juntado em 3 vias com essa leitura (a action nova fica listada, o edit é escrito) | `FlowApplyScenarios.AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt` (duas faixas, fixtures reativas) |
| Médio: obrigatório vazio num `mapTo` | ODC: só a atribuição e o `ListAppend` eram julgados no plano; O11: recusado só ao escrever, sem patch | as duas faixas no plano (`FLOW_MAPPING_TYPES` com o patch quando certo, `Id: NullIdentifier()`), e também o argumento de uma chamada a outra action, tipado pela entrada dela (`IFlowTypes.InputTypeOf`) | `FlowEditTests.AMappingThatLeavesAMandatoryAttributeEmptyIsRefusedInThePlanOfBothLanes`; `FlowApplyScenarios.AValueThePlatformWouldRefuseIsRefusedInThePlan` (duas faixas, com o job do patch escrito) |
| Médio: trocar o nome de duas actions em textos do mesmo op | `APPLY_FAILED` "clashes", sem código | a action cujo nome outro texto do op toma passa antes por um nome livre (`renamedThrough` no recibo), e o seu texto a lê com o nome da leitura | `FlowApplyScenarios.TwoTextsOfOneOpTradeTheNamesOfTheirActions` (duas faixas) |

**Números.** Ambiente isolado (sem worker, TEMP, índice e autoridade próprios), nada ao vivo.
- Testes do kernel nas classes de texto (filtros `C:\t\tx41\j`): Anvil.Tests 165 de 165 (as 155 de antes e 10 novas) e Anvil.Tests.Odc
  135 de 135 (125 e 10). Os 12 testes novos ou mudados de cada faixa falham numa cópia de `566ce568` com eles (12 de 12 no O11 e 12
  de 12 na ODC; as APIs novas com o comportamento de antes) e passam aqui. Fachada: 106 de 106 nos 7 arquivos da junção; o teste
  novo falha na fachada de `566ce568`.
- Classes que a regra da forma JSON toca (jobs de prova e exemplos, lógica JSON, componentes html, protótipo, C#): O11 641 testes
  (`JobTests`, `ExamplesO11Tests`, `HtmlComponentTests`, `HtmlValueTests`, `LogicConstructionTests`, `CSharpLogicTests`, ...),
  todos passam depois da exclusão das ops do planejador; ODC 706, todos menos `OdcJobTests.TheVerifyIdManifestIsTheInstalledOdcCatalog`
  (ambiente: falta `catalog/odc/verify-messages-1.7.28.10850.json` do ODC Studio instalado, não muda aqui).
- Amostras do corpus com as CLIs desta etapa: ponto fixo de lógica igual ao de `566ce568` em 6 módulos (Haiku_CS 13 actions e 65
  nós, DCIPS_Staff_Admin 246 e 1.772, DCIPS_Staff_PastConflicts 75 e 493, FloodServices 26 e 321, FloodQuotes 219 e 1.859,
  EscalaViva 137 e 1.298; nenhum nó opaco novo); LG2 Haiku_CS 12 de 12 e FloodServices 55 de 55; merge Haiku_CS 109 de 109,
  PastConflicts (1 em 6) 87 de 87, FloodServices (1 em 2) 77 de 77, 0 recargas; criação DCIPS_Staff_Admin 48 de 48,
  DCIPS_Staff_Common 13 de 13, FloodQuotes 38 de 38; mapeamento Haiku_CS 12 de 12; C2 GameStore_UI 117 de 117; verifyRefused 0.
- Provas da conferência (`proofs-all.sh`, 59 jobs com as rodadas de patch): 59 de 59 iguais às da junção.
- Provas das revisões (as entradas dos verificadores, `C:\t\tx41\achados\rules`, `ida`): `gs-a1-json-js-screen`, `gs-b1-json-foreach-t1`
  e `ev-b1-json-foreach-t1` recusados; `mg1`, `g1` (O11) e `c1` (ODC) recusados pela regra do elemento novo, `mg1` e `c1` com o patch
  aceito; `k1` `HTML_EDIT_OVERLAP`; os 4 `h-a-*`, `he4`, `he5`, `he7`, `hd2` a `hd5` `HTML_SCRIPT` com o patch aceito; `he1`, `he2`, `he9`,
  `hd1`, `hd7`, `hd8` `HTML_VISIBLE` com o patch aceito; `t1-listinsert` e `t2-listinsert-copy` recusados com o patch aceito;
  `o1-logic-then-edit-same-screen` aceito; `x-drm-o` e `x-drm-d` `FLOW_RENAME_CAPTURED`; `o-dr2` e `d-dr2` `FLOW_BASE_CHANGED` (a
  leitura nova traz o nó opaco); `o-c2` aceito; `o-p8` e `d-p8` `FLOW_MAPPING_TYPES` com o patch. Os que já passavam continuam
  (`e1`, `e3`, `e6`, `e7`, `e8`, `h-c3`, o controle `x-drm-co`). `w1-composite` e `w2-components-doc` seguem aceitos pela CLI (o
  `WIRED` vale para o MCP; a CLI do desenvolvedor aceita as formas).

**O que fica.** 
- **Decisões do dono:** o escape `allowForEach` da forma JSON (só T1/T2, listado) e os 13 jobs de prova que o levam; as ops que o
  planejador da especificação de módulo escreve (contrato, entrega C#, componentes html) não são julgadas pela regra da forma JSON
  (reconhecidas no mesmo processo pelo sha256 do JSON; um job que só as copia, rodado em outro processo, é julgado).
- **Fora da regra da forma JSON:** `create` cru de nó JavaScript ou For Each, e a op `html` na forma JSON (spec de tela) continuam sem
  a decisão 6 e o T1/T2 (o `QUERY_IN_LOOP` já cobria todas).
- **(c) do renome de atributo** é conservador: no merge, um valor de mapeamento que a entrega escreveu e que cita um elemento com o
  nome de um atributo da origem é recusado mesmo quando o autor queria o atributo (duas leituras; a edição pronta resolve). O (b)
  olha as referências do `ValueTypeConversion`; um literal de registro da ODC não é olhado.
- **Merge html da mesma tela:** só para o edit escrito sobre a captura do próprio job; outro `basedOn` continua precisando da leitura
  guardada.
- **Troca de nomes de actions:** um terceiro texto do mesmo op que cite as actions renomeadas (por `$actions` num JavaScript) vê o nome
  provisório e é recusado (`FLOW_BASE_CHANGED`).
- **`WIRED` com composto:** a parte `job:<nome>` só é lida ao lado do job; a que o kernel acharia nas suas raízes é recusada enquanto
  uma rota está desligada.
- **Baixos** das revisões continuam abertos (7 de regras do dono, 8 de ida e volta, 3 de perda de dados), e o classificador das rotas
  (o dono renomeia a funcionalidade).
- **Processo:** nada ao vivo; as baterias inteiras do corpus e os pisos rodam na junção da 24.1.

## 17. A reconferência das correções da 24.1 (12/10/2026)

A reconferência de `102e076b` (`C:\t\tx41\achados\rev2`) achou três high e dois medium. Cada correção tem teste que falha em
`102e076b` (os mesmos ops pela CLI de `102e076b`, nas duas faixas) e passa aqui.

| Achado | Antes | Agora | Teste |
| --- | --- | --- | --- |
| high: a regra da forma JSON seguia o nome declarado | um `rename` (ou um `move`) depois da op JSON: `OwnedAction(nome)` não achava mais a action e a revisão a pulava em silêncio; JavaScript e T1 aceitos nas duas faixas (`a2`, `a3`, `d3`) | a op JSON guarda, quando termina, os nós JavaScript e For Each que escreveu como objetos do modelo; no fim da apply cada nó é julgado onde está (um renome não muda nada, um `move` que recria o objeto é seguido pela substituição da plataforma, um nó que outra op apagou não deixa nada para julgar). Uma action declarada que o módulo não devolve, com passos de JavaScript ou laço, é `FLOW_OWNER_RULES_UNREAD`, nunca pulada; idem uma action com esses nós que não se lê no fim | `FlowApplyScenarios.TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd` (duas faixas, fixtures reativas: renome de client action com JS e de server action com T1, `move` de screen action com JS para outra tela) |
| high: a isenção do `replace` não era um para um | um nó da leitura isentava todo nó do candidato com a mesma lista e o mesmo rótulo: um segundo laço T1 com o rótulo do existente passava (`a6`) | cada nó da leitura isenta no máximo um nó do candidato: o JavaScript de mesmo nome e código; o For Each de mesma lista e rótulo com o mesmo corpo primeiro, senão o único candidato; dois candidatos sem corpo igual: nenhum (os dois são julgados; duas leituras nunca são escolhidas). Um nó que o próprio job escreveu nunca é "da action". O único laço da leitura que o `replace` reescreve em T1/T2 fica como da action (como a forma texto guarda um laço editado da leitura) e é listado: `FLOW_FOREACH_EDITED_KEPT` em `highWarnings`. O ponteiro não aponta para um passo cujo nome dois passos dão | o mesmo cenário (segundo laço recusado, o mesmo laço sem aviso, o laço reescrito listado) |
| high: `create`, `duplicate` e `move` crus sem decisão 6 e T1/T2 | um nó JavaScript criado numa screen action existente e ligado ao fluxo: aceito, `isValid` true (`a7b`) | os nós JavaScript e For Each que uma op crua do job cria, copia (`duplicate` de uma action leva os nós dela) ou move para outra action são julgados no fim pelas mesmas regras, com o ponteiro da op (`/ops/i`) e a correção escrita para ops cruas. `allowForEach {why}` vale também em `create`, `duplicate` e `move` (só T1/T2, listado); JavaScript novo não tem escape. Uma client action nova só com o script continua aceita | o mesmo cenário (JS cru em client action que faz mais: recusado em `/ops/0`; client action isolada crua: aceita; `duplicate` de action com T1: recusado, e com `allowForEach`: aceito e listado) |
| medium: `WIRED` desligado e documento com U+0085 na frente | a fachada usava o `\s` do JavaScript (sem U+0085, com U+FEFF) e o kernel o do .NET (com U+0085, sem U+FEFF): `textFormOf` dizia nulo e o kernel construía a tela (`w1-nel-document`) | a fachada escreve a classe do kernel por extenso (`KERNEL_SPACE`: `\t \n \v \f \r`, U+0085 e os separadores `\p{Z}`), antes do documento e depois da tag; um teste de cada lado fixa a mesma tabela em todos os pontos de código | `text-routes.test.mjs`: `the space before a document and after its tag is the kernel's...`; `ScreenHtmlEditTests.TheSpaceOfADocumentIsTheClassTheFacadeWritesOut` (duas faixas) |
| medium: ops logic aninhadas e planejadas fora da regra em silêncio | uma op `html` com `components` (o handler de um botão é uma screen action com JavaScript `Run`), ou as ops do planejador no job, nunca eram julgadas e nada dizia isso | a decisão do dono fica (não são recusadas), mas agora são julgadas e listadas: `FLOW_OWNER_RULE_PLANNED` em `highWarnings`, com a regra (`rule`), a op que as rodou (aninhada: a op `html`, `prototype`, `rest-expose` ou `agent`; no topo: o planejador da especificação de módulo) e a correção | `HtmlComponentTests.TheOwnerRulesOnWhatThePlannerWroteAreListedNeverSilent` (aninhada e no topo) |

**Recusas novas.** Um job que cria cru (ou copia) JavaScript numa action que não é uma client action isolada e nomeada, ou um For
Each T1/T2, agora é recusado como a forma JSON já era. Nos jobs de prova, só a suíte `tickets` (escrita antes da regra) tinha laços
crus T2: os 6 (`User_Permissions`, `Ticket_Create`, `Ticket_ChangeStatus`, `Comment_Add`, os dois de `Ticket_Timeline`) levam
`allowForEach` com o motivo e saem listados. `LogicConstructionTests` (caso `javascript`) aplicava a expansão crua de uma client
action com JavaScript e um assign de local: o valor preparado passou a ser uma saída, e a action segue isolada nas duas formas. Os
jobs com JavaScript cru em client actions isoladas e os For Each crus T3 continuam aceitos.

**Números.** Ambiente isolado (sem worker; TEMP, índice e autoridade próprios), nada ao vivo.
- Os mesmos ops dos testes novos pela CLI de `102e076b` (O11 e ODC): renome com JS, renome com T1, `move` de screen action com JS,
  JS cru em client action que faz mais, `duplicate` de action com T1, segundo laço com o rótulo do existente e laço reescrito: todos
  aceitos sem aviso; `duplicate` com `allowForEach` recusado (chave desconhecida); componentes html aceitos sem lista. Aqui: recusados,
  aceitos e listados como a tabela diz. As entradas da reconferência (`a1`, `a2`, `a3`, `a4`, `a6`, `a6b`, `a7`, `a7b` no GameStore,
  `d3` no EscalaViva): todas recusadas; `a8b` (`duplicate` de screen action com JavaScript) recusado.
- Classes que a regra toca (jobs de prova e exemplos, lógica JSON, componentes html, protótipo, C#, texto): O11 831 testes, 821 na
  primeira rodada e os 10 que caíram (9 jobs `tickets`/`logic-spec-services`, 1 `LogicConstructionTests` `javascript`) passam depois
  dos ajustes acima; ODC 845, 841 na primeira rodada, os 3 jobs (`data-action`, `client-storage`, `structure-list-type`) passam depois
  dos ajustes, e fica `OdcJobTests.TheVerifyIdManifestIsTheInstalledOdcCatalog` (ambiente, como na seção 16).
- Fachada: 107 de 107 nos 7 arquivos (o teste novo falha na fachada de `102e076b`: U+0085 e U+FEFF divergiam).
- Provas da conferência (`proofs-all.sh`, 59 jobs com as rodadas de patch): 59 de 59 iguais às de `102e076b`. Entradas das revisões
  das regras do dono (`achados\rules`, 41 jobs): iguais às da CLI final de `102e076b` (o `m1-all-kinds` da lista antiga era de uma
  CLI anterior; o smoke de `102e076b` dá o mesmo que aqui).
- Amostras do corpus (o caminho das baterias não passa pela regra): merge Haiku_CS 109 de 109, 0 recargas; criação
  DCIPS_Staff_Common 13 de 13; verifyRefused 0.

**O que fica.**
- **Decisão do dono (nova):** um nó JavaScript ou For Each que já existia e que um `move` leva para outra action é julgado como
  escrito lá (é JavaScript novo naquela action); um `move` da action inteira não muda o dono dos nós e não é julgado. Um nó que uma
  op posterior do job apagou não deixa nada para julgar (não é problema).
- **Ainda fora:** a op `html` na forma JSON (spec de tela, `HtmlExpander`) cria JavaScript e For Each dentro da própria op, sem a
  decisão 6 e o T1/T2 e sem lista (não é op logic); os `create` aninhados em outras ops (spec, screen) idem.
- **Ambiente:** `Pa3KlFootprintTests` e `VerbSurfaceTests.TheIntegrationOpsArePinnedToTheDispatcher` falham com `FileNotFoundException`
  (OutSystems.Model.V1, antes da primeira linha) quando rodam antes de qualquer teste que ligue o Studio no processo; o segundo passa
  na rodada larga; o primeiro não foi rodado com o Studio ligado aqui (a auditoria do footprint não muda com esta etapa).

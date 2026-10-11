# Leitura residente de snapshots ODC e O11

`inspect` reutiliza uma captura nativa em um processo dedicado somente a leitura.
Cada chamada relê o arquivo e verifica SHA-256 antes de reutilizar o modelo ou uma resposta.
Uma consulta nova usa o mesmo leitor de propriedades e referências já existente;
uma consulta idêntica bem-sucedida pode reutilizar também seu resultado.

O compartilhamento está em `kernel/src/Anvil.Core/Kernel/SnapshotReading.cs`,
`kernel/src/Anvil.Core/Hosting/SnapshotReadServer.cs` e
`platforms/odc/facade/reader-client.mjs`. ODC e O11 acrescentam apenas o adaptador de carga
para seu modelo nativo. Não existe cópia do motor de leitura por plataforma.

**Regra para agentes:** para ler uma aplicação, leia o resumo do módulo uma vez: MCP
`ssam_map {lane, target, view:"digest"}` (CLI `ssam map --digest`), as páginas de que a tarefa precisa. Trabalhe no
contexto. O mapa (`ssam_map {lane, target}`) lista os elementos com `@key`. Use `inspect` (abaixo) só para descer numa
`@key`, com o sha256 esperado.

## Resumo do módulo (view "digest")

O módulo inteiro como texto compacto (`ssam-digest/1`, `kernel/src/Anvil.Core/Kernel/ModuleDigest.cs`): referências,
entidades, estruturas, variáveis, roles, exceções, actions em pseudocódigo, timers, REST/SOAP, telas e blocos com
widgets e eventos, e a cobertura. Determinístico: os mesmos bytes dão o mesmo texto.

```powershell
.\ssam map --lane o11 <captura.oml|Módulo> --digest
.\ssam map --lane odc <captura.oml|Módulo> --digest --page 2
```

MCP `ssam_map {lane, target, view:"digest", page?, budgetBytes?, expectedSourceSha256?}`. O alvo segue as regras do
mapa: `.oml`, ou nome de módulo (capturado sem abrir aba; no O11 fechado ou de sistema, o OML publicado). Filtros e
`offset` do mapa são recusados no resumo; `page` é recusado no mapa.

**Nada cortado em silêncio.** Texto longo diz quantos caracteres faltam (`…(+N)`). Expressão passa de 2000 caracteres
só com `…(+N @key)`: o `inspect` dessa `@key` com `full:true` traz o resto. A cobertura conta cada elemento: desenhado,
valor de um dono desenhado, dobrado com o motivo (assinaturas de referência, temas, pastas...) ou não desenhado, por tipo.

**Páginas** (fachada `platforms/odc/facade/module-digest.mjs`), dentro do orçamento (38912 bytes no servidor `ssam`):
- O resumo inteiro cabe: uma página, o texto como foi escrito.
- Senão, a página 1 (e as seguintes enquanto durar) é a visão geral: cabeçalho, entidades e estruturas, o índice de
  todas as actions só com assinatura (kind, public, entradas e saídas com tipos, o que chama e quem chama) e a cobertura.
  Entidade estática com mais de 10 registros mostra os 10 primeiros, a contagem e a página do resto.
- Depois, os corpos por seção (actions agrupadas por pasta), em ordem estável, e os registros dobrados.
- `contents` (página 1) dá as páginas de cada parte. `continuations.page` lê qualquer página.
- Bloco maior que o espaço é quebrado em limite de linha: a página diz onde continua; a seguinte repete o título da
  parte e a primeira linha do bloco. Linha maior que a página é quebrada do mesmo jeito, com as duas marcas.
- Toda página traz `sourceSha256` e `file`. `continuations.next` fixa `target` (o arquivo da captura),
  `expectedSourceSha256` e `budgetBytes`: todas as páginas vêm da mesma captura e da mesma paginação.

**Armazenamento.** Ao lado do índice: `<raiz do índice>\v1\<faixa>\<sha256>.kernel.digest.json`. A chave é o sha256 dos
bytes e a versão do extrator (`ModuleDigest.Extractor`, conferida também no Node). Escrita atômica, no corte de 512 MB
da pasta. Arquivo inválido, de outra versão, faixa ou captura é falta. Na falta, a fachada pede `{"digest":"ensure"}`
ao leitor residente do kernel da faixa: `anvil read-serve` no O11, `anvil-odc read-serve` no ODC. O leitor do builder
não serve: o Model API público mostra widgets como árvores `Content` que o resumo não desenha (2.260 elementos sem
desenho no ODC-B (app), contra 0 pelo kernel). A fachada nunca roda .NET no próprio processo. CLI fria do kernel:
`anvil digest --oml <captura> [--out <txt>]` e `anvil-odc digest ...` (mesmo armazenamento).

**Medidas** (10/10/2026, pela fachada, `budgetBytes` 38912; tokens = bytes/4; frio = leitor novo, carga e resumo):

| Captura | Faixa | OML | Páginas | Pág. 1 | Resumo | Tokens (páginas) | Frio | Com cache |
|---|---|---|---|---|---|---|---|---|
| Haiku_CS | O11 | 0,45 MB | 1 | 30,1 KB | 27 KB | 6,9k | 5,1 s | 1 ms |
| O11-A (cadastro) | O11 | 2,7 MB | 4 | 34,6 KB | 95 KB | 27k | 2,5 s* | 1 ms |
| ODC-A (serviços) | ODC | 0,44 MB | 4 | 34,6 KB | 88 KB | 25k | 6,3 s | 1 ms |
| ODC-B (app) | ODC | 5,9 MB | 14 | 34,7 KB | 380 KB | 107k | 9,4 s | 55 ms / 1 ms |
| O11-B (casos) | O11 | 2,6 MB | 22 | 34,8 KB | 622 KB | 177k | 7,9 s | 64 ms / 1 ms |
| O11-C (integrações) | O11 | 5,3 MB | 71 | 34,2 KB | 2.064 KB | 558k | 6,6 s* | 158 ms / 1 ms |

\* leitor já de pé. Com cache: processo Node novo / mesmo processo; as outras páginas, cerca de 1 ms. Visão geral:
1 página nos três menores, 2 no ODC-B (app), 5 no O11-B (casos) e 8 no O11-C (integrações) (os 3.524 registros de
estáticas ficam nas páginas 34-71).

## Busca e usos (views "search" e "uses", índice rico)

Perguntas transversais numa chamada, sobre uma captura ou a lista de capturas de um app: onde um texto aparece, onde
uma site property é usada, quem chama uma action pública em outros módulos, o impacto de mudar uma entidade.

```powershell
.\ssam map --lane o11 <captura|Módulo>... --search "Site.MaxLines" [--regex] [--property Condition] [--kind K] [--role R]
.\ssam map --lane odc <captura|Módulo>... --uses "Servicos.ExistingQuote" [--kind K]
```

MCP `ssam_map {lane, target, view:"search", text, regex?, property?, kind?, role?, offset?, max?}` e
`ssam_map {lane, target, view:"uses", element, kind?, role?, offset?, max?}`. `target` é uma captura, um módulo ou uma
lista de até 16 deles; `expectedSourceSha256` é um hash ou a lista, um por alvo.

- `search`: texto (substring sem caixa, ou `regex:true`) nas expressões, valores, argumentos e nomes. Cada achado traz
  módulo, `@key`, tipo, caminho, propriedade (`arg:<parâmetro>` para argumento) e o trecho. Trecho cortado diz
  `clipped` e `textLength`; o `inspect` da captura (`captures[i].inspect`, com `properties` e `full:true`) traz o valor.
- `uses`: `element` é `@key`, `Módulo.Elemento`, caminho de nomes (`MainFlow/Home/Search`), `Kind:Nome` ou nome.
  Nome vale primeiro para o elemento de topo (filho do módulo, ou assinatura logo abaixo de uma referência); os aninhados
  de mesmo nome contam em `alsoMatched`. Nomes de elementos diferentes: `AMBIGUOUS_ELEMENT` com os candidatos.
  A resposta lista cada consumidor (módulo, `@key`, caminho), a propriedade que usa (`via`), `direct` ou `descendant`
  (um atributo, um parâmetro) e `crossModule`. Usos dentro do próprio elemento não contam.
- Entre módulos, a identidade é a `GlobalKey` (`<chave do módulo>*<chave do elemento>`): a assinatura no consumidor tem
  a do produtor. Sem a captura do produtor, a assinatura responde por ele. Módulo fora de `target` não é visto.
- Consumidor roda a versão do produtor com que foi compilado: depois de mudar o produtor, atualize as referências e
  republique cada consumidor listado.

**Índice rico** (`ssam-rich-index/1`, `kernel/src/Anvil.Core/Kernel/ModuleRichIndex.cs`). Por elemento: chave, tipo,
nome, pai, papel, propriedades com valor (literal, enum, `True`, nome do alvo), o texto de toda expressão, os argumentos
das chamadas (parâmetro → expressão) e as referências que ele faz (alvo e propriedade). As referências vêm das
propriedades e do grafo nativo (`Referers`), que acha o que uma expressão usa. Argumento e elemento de expressão falam
pelo dono. Ficam fora: `False`, texto vazio, binário, listas que só repetem os filhos e a contabilidade do modelo
(chaves, posições, descritores do ODC). Determinístico, menos `createdAt`.

**Sob pedido.** Só `search` e `uses` constroem; mapa, resumo e leitura nunca. Ao lado do índice:
`<raiz do índice>\v1\<faixa>\<sha256>.kernel.rich.json`, com a versão do extrator (`ModuleRichIndex.Extractor`, conferida
no Node). Na falta, a fachada pede `{"rich":"ensure"}` ao leitor do kernel da faixa (o mesmo do resumo) e diz em `built`
e `captures[i].cache` quanto levou (`ensureMs`, `loadMs`, `buildMs`). CLI fria: `anvil rich-index --oml <captura>` e
`anvil-odc rich-index ...`. A fachada lê o arquivo sem .NET e guarda em memória os últimos (até 6 e 64 MB de arquivos).

**Páginas.** Dentro do orçamento (38912 bytes no servidor `ssam`), com `count`, `returned`, `nextOffset` e
`continuations.next`, que fixa as capturas por arquivo e hash. Nada some entre páginas.

**Medidas** (10/10/2026). Frio: processo novo da CLI (liga o Studio, carrega, constrói, grava). Leitor de pé: carga do
modelo + construção no leitor residente. Consulta: Node novo (lê e valida os arquivos) / mesmo processo.

| Captura | Faixa | OML | Índice rico | Elementos | Frio (CLI) | Leitor de pé (carga + build) |
|---|---|---|---|---|---|---|
| Haiku_CS | O11 | 0,47 MB | 0,35 MB | 880 | 5,0 s | 2,8 + 0,5 s (leitor novo: 7,0 s) |
| O11-D (núcleo, fixture) | O11 | 1,4 MB | 2,7 MB | 16.794 | 9,4 s | 0,3 + 1,7 s |
| O11-A (cadastro) | O11 | 2,9 MB | 4,5 MB | 17.770 | 10,0 s | 1,2 + 3,9 s |
| O11-B (casos) | O11 | 2,7 MB | 4,5 MB | 31.422 | 10,6 s | 1,3 + 9,5 s |
| O11-E (análise, fixture) | O11 | 3,5 MB | 6,9 MB | 47.260 | 17,8 s | 0,9 + 4,2 s |
| O11-C (integrações) | O11 | 5,6 MB | 17,4 MB | 147.085 | 16,5 s | 3,4 + 11,3 s |
| ODC-A (serviços) | ODC | 0,46 MB | 1,0 MB | 4.459 | 9,1 s | 6,3 + 2,3 s (leitor novo) |
| ODC-B (app) | ODC | 6,1 MB | 5,7 MB | 26.422 | 22,2 s | 6,6 + 13,4 s |
| insurance-reactive-r8 (fixture) | ODC | 6,5 MB | 7,4 MB | 35.534 | 20,0 s | 3,5 + 6,9 s |

Perguntas reais, uma chamada cada (antes: N chamadas de map/inspect, contadas pelo caminho mais curto):

| Pergunta | Alvo | Resposta | Consulta | Antes |
|---|---|---|---|---|
| Quem chama `CanReadCase` do O11-B (casos)? (`uses`) | O11-B, O11-C, O11-A | 96 usos, 64 consumidores, 75 no O11-C, com `via`; 1 página | 640 ms / 13 ms | 7 (map + usages por módulo, 2 páginas no O11-C); 71 para saber a propriedade de cada consumidor |
| Onde aparece `Site.IsProduction`? (`search`) | os mesmos 3 | 5 achados (argumentos `arg:IsProduction`) | 526 ms / 32 ms | 3 inspect `--text` (um por módulo, árvores inteiras) + 5 para achar a propriedade |
| Impacto de mudar `ExistingQuote` do ODC-A (serviços) (`uses`) | ODC-B, ODC-A | 225 usos, 63 consumidores, 121 no ODC-B; 3 páginas | 151 ms / 3 ms | 7 (map + usages, 2 a 3 páginas, por módulo); 70 com a propriedade |
| Filtros e condições sobre `Carrier.` (`search`, `property:"Condition"`) | ODC-B | 36 achados (filtros, joins, ifs) | 126 ms / 17 ms | 52 (map dos 51 aggregates + um inspect por aggregate) |

## Mapa do módulo (índice persistente por captura)

A primeira leitura de qualquer aplicação, nas duas faixas:

```powershell
.\ssam map --lane odc <captura.oml|Módulo>                  # todos os elementos: @key, kind, papel, pai, caminho
.\ssam map --lane o11 <captura.oml> --role screen
.\ssam map --lane odc <captura.oml> --kind ServerAction --prefix Get
.\ssam map --lane odc <captura.oml> --parent '@<chave>'      # filhos diretos de um elemento
```

MCP `ssam_map {lane, target, kind?, name?, prefix?, role?, parent?, key?, offset?, max?, budgetBytes?, includeDetail?,
expectedSourceSha256?}` no servidor `ssam` (as duas faixas; o O11 também, pelo argumento `lane`) e no servidor ODC;
`odc map` é o mesmo verbo. Em seguida, `continuations.inspect` da resposta traz a chamada pronta para um `@key`:
`studio_inspect {target, path:"@<chave>", expectedSourceSha256}` / `odc inspect <captura> "@<chave>"
--expectedSourceSha256 <hash>` no ODC e `ssam inspect --lane o11 --oml <captura> --path @<chave>
--expectedSourceSha256 <hash>` no O11. `continuations.next` é a próxima página.

**Módulo O11 por nome (A29, pacote atritos 2).** `ssam_map {lane:"o11", target:"<Módulo>"}`, `o11_inspect {module}` e o
`discover` com módulo nunca abrem aba no Studio (`module-map.mjs` `captureO11Module`):
- módulo aberto numa aba: captura pela chave, sem selecionar a aba e sem a trava de escrita;
- módulo fechado, ou de sistema (`Users`, `OutSystemsUI`, `System`, em qualquer grafia): lê o OML publicado
  (`downloadModule` de `o11-environment.mjs`), sem aba e sem trava. A resposta do mapa traz
  `capturedBy:"published-oml"` e `versionId`: é a versão publicada, não a aba;
- sem esse download no build: `MODULE_NOT_OPEN` com a continuação `o11_environment {action:"download", module}`;
- módulo aberto que precisa ser selecionado (ainda abrindo, bridge antiga): a seleção entra na fila de escrita do
  Studio (`docs/CONEXAO-STUDIO.md`);
- `o11_studio open-module` ou `snapshot {module}` de um módulo de sistema: `SYSTEM_MODULE_NOT_OPENABLE`, com
  `ssam_map` como continuação.

`o11_dependencies {action:"inspect", oml:"<arquivo>.avsig"}` lê o envelope JSON da assinatura na fachada, sem a CLI:
producer, kind, chave, ambiente, atestação e elementos (paginados por `offset`/`limit`). `capture` sem `out` grava em
`<.local da faixa>\dependencies\<producer>-<sha8 dos elementos>.avsig` e devolve `out`.

**Armazenamento e identidade.** `<raiz>\.local\module-index\v1\<faixa>\<sha256>.<adaptador>.json`
(`SSAM_MODULE_INDEX_ROOT` muda a raiz; a fachada a resolve e a entrega absoluta a cada leitor que inicia, então
leitor e mapa usam a mesma pasta mesmo com os leitores fora da área de trabalho). `sha256` é o dos bytes da OML;
o adaptador é `builder` (leitor ODC) ou
`kernel` (leitor O11): os dois leitores ODC concordam nas chaves mas não em nomes e caminhos, por isso o índice é
de um adaptador. A identidade é o conteúdo, nunca caminho ou data: qualquer cópia dos mesmos bytes reutiliza o
índice; uma captura nova com outros bytes tem outro. O Node calcula o hash da captura e lê o arquivo direto, sem
.NET; ele só é servido quando `schema` (`ssam-module-index/1`), `extractor` e `sourceSha256` conferem. Arquivo
corrompido, parcial, de outro hash ou de outra versão é falta (reconstrução), nunca resposta. O armazenamento é um
cache: quem escreve (o leitor C#) grava de forma atômica e corta cada pasta de faixa em 512 MB pelos mais antigos;
apagá-lo custa só a reconstrução.

**O que responde.** Todo elemento visível ao leitor (o mesmo universo de `inspect --kind *`), ordenado pela chave
como as páginas do leitor: `key`, `kind`, `name` (Name, senão Label), `role` (module, flow, screen, block, action,
actionRef, aggregate, entity, staticEntity, structure, attribute, parameter, variable, widget, event, flowNode,
expression, reference, other), `parentKey`, `path` legível (corte de 80 caracteres por segmento, como o leitor),
`childrenTotal` e `dataType` de parâmetros, atributos e variáveis. O pai é o `Parent()` do modelo: nas fontes de
um agregado (a `DataTable`, O11 e ODC) e nas expressões de propriedades ODC (`CustomProperty`) é um elemento que
nenhuma lista de filhos contém; ele entra no `path` e no `--parent`, mas não é listado. Filtros: `--kind`
(qualquer interface que o elemento implementa, como `inspect --kind`: no ODC `WebScreen` lista o mesmo que
`MobileScreen`), `--name` exato
sem diferenciar maiúsculas, `--prefix`, `--role`, `--parent @chave`, `--key @chave`. O mapa simples deixa de fora
as linhas de detalhe (expression, reference, other: 58–72% dos elementos) e as estruturas anônimas/list types;
`--detail`, um `--kind` ou um `--role` as listam, e `hidden` conta o que ficou de fora. Paginação `--offset`/`--max`
(1..500, padrão 100) e `--budget` em bytes UTF-8 (limite rígido: menos entradas, `nextOffset` continua). O padrão
é o teto de resposta do MCP menos a margem do formatador: 38912 bytes com `SSAM_MAX_ANSWER_BYTES` no padrão de 40960
(seção "Teto de resposta do MCP", abaixo). Um orçamento menor que a menor página possível não lança mais erro: devolve
a resposta mínima (sem entradas) com `size.status:"insufficient"`, `size.minimalBytes` e `continuation`, a mesma
consulta com um orçamento que cabe uma página. `counts` traz os totais por papel e, na primeira página, por kind. Não
responde: busca textual, valores de propriedades e expressões, usos, outros módulos. Isso continua no `inspect`.

**Caminho frio.** Com o índice gravado, a resposta não inicia leitor nenhum, inclusive depois do encerramento de
15 minutos do leitor, ao alternar entre OMLs ou em outra sessão: custos medidos das partes, hash 4–17 ms, parse
20–25 ms e consulta abaixo de 3 ms, contra 8,4 s (O11) e 10,6 s (ODC) da primeira chamada num processo leitor novo.
Na falta, `ssam map` envia `{"index":"ensure"}` ao leitor residente da faixa, que carrega a captura se preciso (a
mesma carga de um `inspect`), grava o índice e responde; as próximas chamadas acertam. No ODC essa falta passa pela
mesma verificação de atualização do builder que o `inspect`.

**Aquecimento automático.** Depois de `odc studio snapshot`/`latest` bem-sucedidos (MCP `studio_snapshot`,
`studio_latest`, e o snapshot de `odc deliver`), do snapshot e do candidato de `studio_deliver` com job, de
`ssam download --lane o11` e de `ssam deliver --lane o11` (o snapshot entregue, senão o candidato), a fachada
inicia um processo destacado `node platforms/odc/facade/module-map.mjs --prefetch <captura> --lane <faixa>` que
constrói o índice com a sua própria raiz de leitores (`<readers>-prefetch`): nunca expulsa a captura que um agente
está lendo. Nunca bloqueia nem muda a resposta do verbo; pula quando o índice já existe e nunca compila o builder
ODC (desatualizado, pula; o próximo `map` constrói). O resultado fica em `<readers>-prefetch\prefetch.jsonl`; o
processo leitor do aquecimento segue a regra dos 15 minutos. `inspect` e `map` por nome de módulo não aquecem: o
leitor da faixa já carrega aquela captura. `discover --app` lê do mapa os kinds das capacidades; texto e
assinaturas continuam no leitor.

O pacote de leitura congelado (`ssam package run`, MCP `ssam-headless-selected`) ainda não traz o mapa; um
servidor MCP já aberto só ganha `ssam_map` ao reconectar.

## Teto de resposta do MCP

Nenhuma resposta do servidor `ssam` passa do teto do cliente: `SSAM_MAX_ANSWER_BYTES` (padrão 40960; abaixo de 4096
vale o padrão). A guarda fica no invólucro de todas as ferramentas (`platforms/odc/facade/ssam.mjs`, depois do
formatador de respostas), e vale igual para O11, ODC e os relays:

- Uma ferramenta com orçamento próprio (`budgetBytes` de `ssam_discover`, `ssam_map` e `studio_*`; `budget` do
  `o11_inspect`) recebe o orçamento limitado ao teto menos 2048 bytes antes da chamada, e um `budgetBytes` omitido num
  relay ODC vira esse valor. Assim a resposta cabe e não é paginada.
- Qualquer resposta que ainda passe do teto é gravada inteira em `kernel/.local/answers/<sha256>.json` (raiz que o
  `ssam_evidence` já lê). O cliente recebe só os campos de topo pequenos (textos cortados em 500 caracteres, objetos de
  até 512 bytes; a `continuation` original vira `answerContinuation`), mais `paged:{bytes, file, sha256}` e
  `continuation:{tool:"ssam_evidence", arguments:{file, budgetBytes:20000}}`. A leitura continua por `pointer`,
  `where` e `fields` nesse arquivo; nada é repetido.
- `ssam_evidence` passa intacto: ele é o leitor desses arquivos.
- O sucesso de `ssam_job`/`o11_job` responde em cerca de 1 KB: `ok`, `accepted`, `isValid`, contagens (validação só
  as diferentes de zero; `messages`, `detailsTotal`), os resultados das ops quando cabem (senão `resultsTotal` e a
  leitura deles no `resultFile`). A falha mantém todos os `problems` do preflight, cada texto cortado em 300 caracteres,
  além de mensagens, detalhes e `stderr`, como antes.

## Uso

Na raiz unificada, capture uma versão atual antes de trabalhar em alterações do Studio:

```powershell
.\odc studio snapshot Quotes
# Use o caminho .oml devolvido pelo snapshot nas próximas consultas; o mapa vem primeiro.
.\odc map <captura.oml> --role block --prefix WF_
.\odc inspect <captura.oml> MobileBlock:WF_AddressSearch --depth 4 --full
.\odc inspect <captura.oml> MobileBlock:WF_AddressSearch `
  --select ScreenAction:PlacePin `
  --select ScreenAction:HandlePinNotFoundDropPin `
  --select ScreenAction:DropCoordinatePin `
  --select ScreenAction:PinPlacedOnMap --depth 12 --full
.\odc inspect <captura.oml> MobileBlock:WF_AddressSearch --usages --include-internal --max 20
```

`--select` aceita de 1 a 32 caminhos relativos ao `path` ou referências `@key` daquele escopo.
O MCP `studio_inspect` recebe o mesmo conjunto em `select: ["ScreenAction:PlacePin", ...]`.
Cada entrada tem `selector`, `ok` e `data` ou `error`. `complete` do lote significa que
todas as seleções foram resolvidas; não significa profundidade ilimitada. Consulte os cortes
e os indicadores de completude de cada seleção, também presentes no resumo.

No O11, a mesma entrada e o mesmo transporte:

```powershell
.\ssam inspect --lane o11 --oml <captura.oml> --path / --kind MobileScreen --properties Name
.\ssam inspect --lane o11 --oml <captura.oml> --path / --select '@chave1' --select '@chave2' --depth 4 --full
```

O `inspect` O11 sem opções de leitura mantém o relatório legado com validação.
O CLI nativo direto continua disponível para diagnóstico independente com carga fria.
Depois de alterar o C# do kernel, compile pela receita `kernel/scripts/build.py` antes de
usar seu CLI; o leitor valida os binários carregados, não compila o kernel automaticamente.
O builder ODC verifica os arquivos efetivamente incluídos no projeto e recompila se necessário.
Uma edição de bridge que não entra no builder deixa de provocar builds repetidos.

## Resposta e navegação

- `sourceSha256` identifica os bytes lidos. Use `--expectedSourceSha256 <hash>` para recusar
  uma consulta se o arquivo mudou desde a seleção das chaves.
- `cache.modelHit` e `cache.queryHit` distinguem reaproveitar a carga de reaproveitar a resposta.
  `loads`, `instanceId`, `pid` e `generation` permitem conferir o que aconteceu.
- `out` contém o JSON completo solicitado. `--budget` controla quando ele vem inline;
  é um limiar para a árvore, não um limite rígido do envelope e do resumo.
- Ao ultrapassar o orçamento, `summary` traz identidades para navegação, contagens, cortes,
  erros, seleções e amostra de usos. `navigation.target` é a OML; `out` é a evidência JSON.
  Passe uma referência do resumo como próximo `path`, com o hash esperado.
- Consultas vazias preservam `kindObserved`, `searchComplete` e avisos. Não encontrar um
  nome em um tipo observado é diferente de não observar esse tipo no escopo.
- `full` preserva textos e coleções de propriedades; `depth` e `max` ainda limitam a árvore.
  `childrenOmitted`, `propertiesOmitted`, `propertiesMissing` e erros não são ocultados.

## Invalidação, isolamento e limites

Uma troca de bytes no mesmo caminho invalida a captura mesmo com tamanho e data iguais.
`--cold` força nova carga para diagnóstico. Falha de carga não devolve o modelo anterior.
Respostas com erros de leitura ou consultas incompletas não entram na memória de respostas.
As chaves continuam vinculadas à captura: após nova captura, recarga ou merge, resolva-as novamente.

A geração considera conteúdo dos binários do leitor e suas dependências, versão do cliente,
configuração de runtime, metadados das bibliotecas nativas e conteúdo das quatro DLLs centrais
do modelo. Mudanças normais na instalação/runtime iniciam outra geração. Isso não é uma
verificação criptográfica integral de todos os arquivos da instalação.
Cada geração executa uma cópia própria dos binários do leitor; nenhuma DLL carregada no Studio
é substituída. O serviço escuta somente no loopback, exige a autoridade local do Hybrid e recusa
comandos de edição. Não compartilha objetos com o worker de escrita.

Há uma captura por processo, até 128 respostas e 16 MiB de respostas memorizadas
(máximo de 4 MiB por resposta). Alternar entre OMLs diferentes exige nova carga.
Após 15 minutos sem leituras, o processo encerra; a próxima chamada é fria.
Gerações antigas podem coexistir até esse encerramento. Arquivos de evidência continuam no
journal: esta mudança não implementa a política de limpeza de `lab` ou dos journals.
`SSAM_READER_CACHE_ROOT` permite isolar uma sessão de leitura ou benchmark; cada raiz mantém
seus próprios processos. A prova usa essa opção para não disputar a captura de outras tarefas.

Consultar pelo nome de módulo continua obtendo um snapshot novo no Studio em toda chamada.
Os ganhos de leituras repetidas de arquivo não eliminam o custo dessa captura viva.
Listagens por kind, nome, prefixo, papel ou pai vêm do mapa do módulo (acima), sem percorrer o modelo; uma
busca textual nova ou uma leitura de propriedades ainda pode percorrer todo o modelo no leitor.
Também não é uma análise do comportamento de bibliotecas JavaScript externas.

`timings` separa hash, carga, consulta, transporte, preparação da resposta e total da fachada.
Alguns intervalos são inclusivos: transporte inclui espera e execução no servidor;
consulta inclui a preparação/memorização do JSON no servidor. Não some todos os campos.
O benchmark mede ainda o tempo externo do processo da CLI, incluindo sua inicialização.

## Quando a leitura é suficiente para uma alteração

Velocidade e fidelidade são condições necessárias, mas não certificam uma refatoração inteira.
Antes de editar, confira que:

1. A captura corresponde à versão que será usada como base da entrega.
2. A seleção identifica os elementos certos e inclui seus filhos relevantes, sem ambiguidade.
3. Propriedades, expressões, fluxo e usos necessários foram lidos; os cortes e páginas restantes
   foram resolvidos. Um retorno vazio com erro de leitura não prova ausência de consumidores.
4. Dependências fora da captura foram consideradas. Esta consulta não descobre automaticamente
   consumidores de outros módulos, referências em strings ou dependências dinâmicas de bibliotecas.
5. A edição usa uma operação suportada e é verificada no candidato, inclusive após salvar/recarregar.

O corpus anterior ampliou a evidência de usos ODC para 108 tipos de alvo observados; ele não
certifica todas as propriedades desses tipos nem todas as operações de edição. A evidência O11
está em fixtures e testes próprios; compartilhar o algoritmo não substitui provar cada adaptador.
Veja [USOS-REFERENCIAS.md](USOS-REFERENCIAS.md) para os limites da prova de reapontamento.

O endereçamento também tem um limite explícito: nós de árvores/consultas, referências diretas,
arestas de usos e cada entrada do mapa do módulo trazem identidades estruturadas; o mapa dá uma chave
navegável a todo elemento visível ao leitor. O mapa legado do builder ODC (`odc inspect <Módulo>` sem
caminho) continua só com nomes; use `ssam map`. Coleções de propriedades ainda podem aparecer como texto
`Kind:Nome`, sem identidades individuais nessa representação. Não há, portanto, garantia de que toda
ocorrência referenciada dentro de uma propriedade venha acompanhada de uma chave navegável. Emitir identidades
nas coleções e provar a resolução de cada endereço retornado é uma lacuna de completude separada.

## Reprodução da prova

Com os CLIs compilados e sem suítes nativas concorrentes:

```powershell
node scripts/prove-reading.mjs --quotes <Quotes-562438...oml> --out <diretorio-novo>
```

A prova executa 20 repetições por consulta pela entrada pública, compara o resultado com
cargas frias independentes, verifica as quatro actions completas, consultas vazias,
paginação de usos e o adaptador O11. Mede também o percurso completo de `studio_inspect`
em uma sessão MCP persistente, para o block e o lote de quatro actions, conferindo o mesmo
resultado integral da CLI. Compara os filhos por chave: sua enumeração pode variar.
No O11, compara também os resumos completos `Nodes`, `Roles` e `ScreenActions` como conjuntos
com multiplicidade, quando contêm somente pares `Kind:Identifier` sem ambiguidade. Essa ordem
também varia entre cargas dos mesmos bytes. Propriedades restantes, coleções de valores,
parâmetros e referências de fluxo continuam sendo comparados integralmente.
Os hashes finais precisam corresponder aos originais. O relatório inclui mediana, p95,
tempos por etapa, chamadas, bytes e evidências individuais.

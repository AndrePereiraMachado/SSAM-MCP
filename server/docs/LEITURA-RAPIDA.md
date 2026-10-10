# Leitura residente de snapshots ODC e O11

`inspect` reutiliza uma captura nativa em um processo dedicado somente a leitura.
Cada chamada relê o arquivo e verifica SHA-256 antes de reutilizar o modelo ou uma resposta.
Uma consulta nova usa o mesmo leitor de propriedades e referências já existente;
uma consulta idêntica bem-sucedida pode reutilizar também seu resultado.

O compartilhamento está em `kernel/src/Anvil.Core/Kernel/SnapshotReading.cs`,
`kernel/src/Anvil.Core/Hosting/SnapshotReadServer.cs` e
`platforms/odc/facade/reader-client.mjs`. ODC e O11 acrescentam apenas o adaptador de carga
para seu modelo nativo. Não existe cópia do motor de leitura por plataforma.

**Regra para agentes:** para ler uma aplicação, comece por `ssam map` / MCP `ssam_map`; depois leia
subárvores, propriedades e usos por `@key` com o sha256 esperado (`inspect`, abaixo).

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

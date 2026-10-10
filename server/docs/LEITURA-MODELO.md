# Leitura de modelos — 18/09/2026

Complementos: [usos e reapontamento](USOS-REFERENCIAS.md) e
[caso real de fricção durante o ajuste do pin](FRICCAO-LEITURA-QUOTES.md).
Para reutilização de capturas, consultas em lote e medições, veja [leitura rápida](LEITURA-RAPIDA.md).

O leitor de árvores, consultas, paginação e identidades é único:
`kernel/src/Anvil.Core/Kernel/ModelReading.cs`. É compilado nas duas versões do kernel e ligado por fonte
ao builder ODC. `KernelModelReader` adapta a API comum O11/ODC; o builder mantém um adaptador pequeno para
os descriptors do ODC. Não há uma cópia do algoritmo por plataforma.

## Entrada existente

Para ler uma aplicação, comece por `ssam map` / MCP `ssam_map`; depois leia subárvores, propriedades e usos por
`@key` com o sha256 esperado. O mapa lista, a partir do índice persistente da captura, cada elemento visível ao
leitor com chave, kind, papel, pai e caminho, filtrável por kind, nome, prefixo, papel e pai, nas duas faixas:

```powershell
.\ssam map --lane odc <arquivo.oml|Módulo> --role screen
.\ssam map --lane o11 <arquivo.oml> --kind ServerAction --prefix Get
```

Armazenamento, identidade, o que o mapa responde, o caminho frio e o aquecimento automático:
[leitura rápida](LEITURA-RAPIDA.md#mapa-do-módulo-índice-persistente-por-captura). As consultas abaixo continuam
para o que o mapa não cobre (texto, propriedades, expressões, usos, subárvores).

ODC, pela raiz unificada:

```powershell
.\odc inspect <arquivo.oml> --kind MobileScreen --max 20 --properties Name
.\odc inspect <arquivo.oml> --kind MobileScreen --max 20 --offset 20 --properties Name
.\odc inspect <arquivo.oml> "MobileFlow:MainFlow/MobileScreen:Dashboard" --depth 3
.\odc inspect <arquivo.oml> --text "GetQuotes" --properties Name,Label,Text --max 30
.\odc inspect <arquivo.oml> "@<chave-da-mesma-captura>" --full --depth 0
```

`studio_inspect` oferece os mesmos parâmetros (`kind`, `name`, `text`, `properties`, `offset`). Um nome
de módulo continua capturando o módulo aberto antes da leitura. Para paginar ou usar uma chave exata,
reutilize o `file` devolvido na primeira resposta: capturar novamente pode mudar o conteúdo e a posição das páginas.

O11, usando o mesmo leitor:

```powershell
.\ssam inspect --lane o11 --oml <arquivo.oml> --kind MobileScreen --max 20 --properties Name
.\ssam inspect --lane o11 --oml <arquivo.oml> --path "MobileFlow:MainFlow/MobileScreen:Dashboard" --depth 3
```

A CLI do kernel ODC aceita essa mesma sintaxe `--oml` / `--path`. As entradas antigas sem parâmetros de
consulta preservam seus resumos: mapa legado só com nomes no builder ODC e resumo/validação no kernel. O mapa
com uma chave por elemento é o `ssam map`.

## Contrato de leitura

- `kind` aceita interface com ou sem `I`; `name` compara nome/label completo sem diferenciar maiúsculas.
- `text` busca nomes e propriedades textuais/expressões completas antes de qualquer corte. Não busca bytes,
  propriedades de auditoria ou strings geradas a partir de coleções de objetos. Falhas de leitura são contadas
  em `propertyReadErrors`, com amostras e `searchComplete=false`; nesse caso a contagem não é exaustiva.
- Consultas retornam `schema=ssam-reading/1`, `count`, `returned`, `offset`, `omitted`, `truncated`,
  `nextOffset` e `entries`. `count` vem da travessia inteira, não da página. `omitted` inclui todas as outras
  páginas, inclusive anteriores. Os resultados são ordenados pela chave para não depender da ordem nativa.
- `kindObserved=false` e `notices` avisam quando nenhum objeto do tipo solicitado foi observado. Isso pode
  ser grafia incorreta ou ausência legítima no escopo; zero resultados não prova que a plataforma não suporta
  o tipo. `--properties` sem caminho lê a raiz projetada e não é ignorado pelo mapa legado do ODC.
- Cada entrada inclui `name` legível, `modelName`, `label`, `kind`, `key`, `reference=@key` e `path` legível.
  Caminhos repetidos são recusados com exemplos e chaves. Caminhos de diagnóstico com nomes longos podem
  estar abreviados: use a referência exata para esses casos. Chaves são opacas, inclusive quando contêm `/`.
- `properties` projeta os campos solicitados. Campos desconhecidos aparecem em `propertiesMissing`.
  `propertyReferences` fornece identidade dos alvos, além do texto legível na propriedade.
- `childrenTotal` / `childrenOmitted` indicam os limites de profundidade e quantidade. `propertiesOmitted`
  informa corte de texto (400 caracteres) e de coleções (20 itens). `full` remove esses dois cortes, mantendo
  os limites de profundidade/filhos. Erros de propriedade aparecem em `propertyErrors`.
- O builder ODC grava cada resposta em arquivo novo, evitando sobrescrever evidências de consultas anteriores.
  `budget` controla caracteres inline; `characters` e `bytes` UTF-8 são medidas diferentes. Acima do orçamento,
  leia `out`. O arquivo contém a consulta com seus limites, não uma exportação integral do módulo.
- O verbo existente `usages` do kernel agora aceita `offset` e informa `returned`, `omitted`, `truncated`
  e `nextOffset`, mantendo `count`, `real`, `byType` e `entries`. A ordem também é determinística.

## Chaves e salvar/reabrir: prova, não suposição

Comparamos todas as chaves observadas no fixture de cada plataforma, carregamos novamente o original e
gravamos/reabrimos uma cópia. O arquivo original não foi modificado.

| Plataforma | Chaves originais | Mantidas ao recarregar | Mantidas após gravar/reabrir |
|---|---:|---:|---:|
| ODC | 35.534 | 35.534 | 35.534 |
| O11/SS4 | 8.579 | 8.579 | 8.579 |

O hash do arquivo salvo mudou em ambos; as chaves não. Isto não prova o comportamento de todo tipo de objeto
ou operação. Não reiniciamos o Studio nem fizemos merge/publicação para esse teste. Não se deve afirmar que
salvar, publicar ou reabrir necessariamente troca chaves. O resultado inclui `sourceSha256` para identificar
a captura; uma nova captura deve ser resolvida novamente quando houver dúvidas sobre identidade ou conteúdo.

Evidências locais: `kernel/.local/lane-odc/reading-tests/identity-proof.json` e
`kernel/.local/reading-tests/identity-proof.json`. O teste registra também as chaves de uma tela e os hashes.

## Verificação e limites

Resultado desta rodada: 5/5 testes específicos no ODC, os mesmos 5/5 no O11/SS4 e 105/105 testes Node
da raiz/fachada/Portal (sem skips). A chamada `studio_inspect` com filtros foi exercitada pelo MCP real.
As CLIs ODC e O11/SS4 e o builder ODC foram recompilados. A entrada pública O11 foi conferida com uma
consulta paginada no fixture. Logs em `.local/migration/*reading*`.

`kernel/tests/Shared/ModelReadingTests.cs` é ligado aos dois projetos de teste, com os mesmos casos:
ambiguidades, chave contendo barra, caminho por interface, paginação com ordem nativa alterada, busca além
do corte, projeção, referências, omissões, falhas de propriedades e load/save/reload em fixtures reais.
O teste nativo também confere paginação do `usages` com consumidores reais.

`platforms/odc/facade/tests/reading.test.mjs` confere a fachada com arquivo real em processos independentes,
paginação sem repetição, caminho/chave, hash inalterado e preservação da evidência anterior.

A regressão O11 anterior a esta alteração terminou com 1.138 testes aprovados e uma falha:
`CSharpTemporalTests.TemporalValuesVerifySaveReloadAndProduceAnEmptyRepeatPlan(TemporalInstants,45)`,
diagnóstico `AVCS310` em fábricas de duração. Esse resultado é a linha de base histórica.
A correção e a revalidação geral posterior estão registradas em `FECHAMENTO-REFERENCIAS.md`.

Este trabalho melhora a leitura. Não altera a resolução ambígua de nomes em todas as operações de escrita e
não prova equivalência semântica de refatorações. O índice persistente veio depois (30/09/2026): um arquivo por
captura (sha256 dos bytes) e adaptador de leitor, servido pelo `ssam map` sem .NET; ele não relaciona capturas
diferentes entre si, e as chaves continuam presas à captura (ver [leitura rápida](LEITURA-RAPIDA.md)).

## Auditoria adicional de confiança

A revisão após a primeira rodada reproduziu duas lacunas na entrada pública: tipo digitado incorretamente
retornava zero sem aviso específico; projeção de propriedades sem caminho era ignorada no ODC. Ambas foram
corrigidas. Os testes compartilhados passaram a 6/6 no ODC e 6/6 no O11. A integração foi ampliada para esses
casos e para comparar a lista completa de telas com o mapa preexistente, por uma leitura independente.
Essa integração ampliada passou. O verificador de atualização do builder também passou a considerar o
arquivo do leitor compartilhado fora de `studio/`; uma alteração só nesse arquivo já exige recompilação,
e fonte ausente/ilegível não permite prosseguir silenciosamente com binário antigo. Um teste isolado com
arquivos temporários verifica essa decisão sem alterar timestamps das fontes reais.

`ok=true` significa execução bem-sucedida, não conteúdo completo. Antes de usar uma resposta como prova,
confira `notices`, `kindObserved`, `searchComplete`, `propertiesMissing`, `propertyErrors`, `propertiesOmitted`,
`childrenOmitted` e a paginação. `full` remove cortes das propriedades, mas não ignora `depth` ou `max`.
Os testes não certificam todos os tipos/propriedades da plataforma nem leitura sem fricção em qualquer app.
Ainda falta uma aceitação mais ampla por tarefas reais (Data, Logic, Interface e integrações), com comparação
independente do conteúdo esperado, incluindo expressões, ligações e referências, e medidas de chamadas/tempo.

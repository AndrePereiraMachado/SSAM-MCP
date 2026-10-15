# Lógica em texto (`ssam-flow/1`): a ida e a volta

Etapas LG1 (ida) e LG2 (volta) do plano `C:\Users\andre\SSAM-analises\html-do-ssam\PLANO.md` (seções 6 e 8). Cada action
do módulo vira um texto que também é fonte: o mesmo pseudocódigo do digest, com o id de cada elemento, as descrições e os
textos inteiros e toda propriedade autorada. O texto lido, editado, volta pela op `logic` do job
(`{"op":"logic","data":{"flow":[{"text","basedOn"}]}}`): só o que mudou é escrito, e cada elemento que o texto manteve
fica com a sua chave. A op `logic` em JSON (`actions`) continua para criação em massa e compatibilidade (decisão 8 do plano).

Código: `kernel/src/Anvil.Core/Kernel/FlowText.cs` (modelo canônico e léxico), `FlowExtract.cs` (modelo → canônico, com as
regras do que fica de fora), `FlowPrint.cs` (impressora), `FlowParse.cs` (parser), `ModuleFlow.cs` (módulo, armazenamento,
ponto fixo); a volta em `FlowDiff.cs` (texto editado → verbos, regras), `Verbs.Flow.cs` (a op, a resolução de nomes, a
releitura) e a bateria em `FlowEdits.cs`/`FlowBattery.cs`. O digest (`ModuleDigest.cs`) continua sendo a leitura do módulo.

## Leitura

```powershell
.\ssam map --lane o11 <captura.oml|Módulo> --flow                       # lista das actions
.\ssam map --lane o11 <captura.oml|Módulo> --flow --element MainFlow/Home/Salvar
.\ssam map --lane odc <captura.oml|Módulo> --flow --element @<chave> --detail   # com a tabela de ids
```

MCP `ssam_map {lane, target, view:"flow", element?, page?, includeDetail?}`. `element`: `@chave`, `Fluxo/Tela/Action`,
`Tela.Action` (como o cabeçalho escreve) ou o nome (sem distinguir caixa quando não há igual exato), ou uma lista de até 50 delas, lidas inteiras numa resposta (as que
não cabem no orçamento vêm em `continuations.next`; CLI: `--element` repetido). Cada action traz `textSha`, o `basedOn` da
edição. Nome de várias actions: `AMBIGUOUS_ELEMENT` com as candidatas;
nenhuma: `ELEMENT_NOT_FOUND` com as parecidas. Action maior que o orçamento vem em páginas (`continuations.next`), sem
nada cortado. Sem `element`: a lista (nome, kind, chave, bytes, `fixedPoint`).

Armazenamento: ao lado do digest, `<raiz do índice>\v1\<faixa>\<sha256>.kernel.flow.json`, uma vez por captura, com o
texto, a tabela de ids e o ponto fixo de cada action. Na falta, a fachada pede `{"flow":"ensure"}` ao leitor do kernel
da faixa (o mesmo do digest). CLI fria: `anvil flow --oml <captura> [--action <nome|@chave>] [--out <txt>]` e
`anvil-odc flow ...`.

## Forma

```
/// Altera o status do pedido.
/// O cancelamento devolve o estoque uma única vez.
server action AlterarStatusPedido public @MrB+ndLCeEidaZwSA+2WWg
  @{Folder=&"Pedidos"}
  /// pedido a alterar
  in PedidoId: Pedido Identifier @p1
  in Motivo?: Text = "" @p2
  out Sucesso: Boolean @p3
  local Pedido: Pedido @l1
  //-> @n1 Confere antes de alterar @n2
  GetPedido = aggregate FROM Pedido WHERE (Pedido.Id = PedidoId) MAX 1 @n1
  if GetPedido.List.Empty:  # O pedido existe? @n3
    raise PedidoNaoEncontrado("Pedido não encontrado") @n4
  assign Pedido = GetPedido.List.Current.Pedido  # Guardar o pedido @n5
  switch:  # Que transição é esta? @n6
    case StatusPedidoId = Entities.StatusPedido.Cancelado:
      DevolverEstoque(PedidoId) @n7
      UpdatePedido(Source=Pedido) @n8
      assign  # Preparar o retorno @n9
        Sucesso = True
        Pedido.Motivo = Motivo
      end @n10
    otherwise:
      -> @n8
  on exception All Exceptions abort log: @n11
    end @n10
```

- **Cabeçalho.** `server action Nome`, `service action Nome`, `client action Nome` (do módulo); `action Tela.Nome` (screen
  action ou action de bloco) e `data action Tela.Nome` (com `fetch=OnDemand` quando não é o padrão) nomeiam o dono antes do
  nome: a tela, o bloco ou o email, pelo nome, ou pelo caminho `Fluxo/Tela` quando duas telas do módulo têm o mesmo nome
  (`FlowOwners`). Depois vêm `public`/`function` (só nas do módulo) e a chave.
- **Ids.** Toda linha de elemento termina no id dele: `@n` nós, `@p` parâmetros (da action e dos nós SQL/JavaScript),
  `@l` locais; o cabeçalho traz a chave do modelo da action. A tabela id → chave fica no armazenamento (`ids`, e
  `start` → o nó Start, que não se escreve: um por action; um comentário ligado a ele o chama `//-> @start`). Ids curtos de propósito: 4 a 5 bytes em vez dos 24 de
  `@` + chave, e o modelo copia sem erro.
- **Fluxo.** Do Start pela ordem dos conectores: um nó é seguido pelo Target na mesma profundidade; o ramo verdadeiro do
  `if` é indentado e o falso continua embaixo; o corpo do `foreach` é indentado e termina em `next`; o `switch` tem
  `case expr:` e `otherwise:` com os ramos indentados. Todo ramo termina em `end @id`, `raise`, `navigate`, `next`,
  `-> @id` (nó escrito em outro lugar) ou `-> (no connector)`. O mesmo End alcançado de novo é `end @id` outra vez.
  Depois do fluxo principal: os handlers (`on exception Exc abort log: @id`) e `unreached:` com os nós que nenhum
  conector alcança (ilhas, cada uma até o fim).
- **Construções.** `X = Acao(P=v, Q)` (argumento sem `=` passa a variável do mesmo nome; o nome do nó só aparece quando
  difere do da action; action de outro módulo com o produtor, como no digest: `(System).ListAppend`);
  `assign X = v` ou `assign` + uma atribuição por linha; `X = aggregate FROM … JOIN … WHERE (…) AND (…) GROUP BY … AGG
  N=Sum(…) CALC N=… SORT a desc … MAX m START s`; `X = sql -> Saida max m` + `in P: Tipo inline = valor @p` + `| sql`;
  `X = javascript` + `in`/`out` + `| código`; `X = JSONSerialize(d)`, `X = JSONDeserialize(s) as Tipo`;
  `message Tipo: expr`, `navigate Tela(args)`, `refresh Fonte max m start s`, `trigger Evento(args)`, `raise Exc(msg)`;
  `// comentário @id` (`//-> @alvo` quando ligado a um nó; linhas seguintes em `| `); nó sem forma própria:
  `X = node Kind(args)` com as propriedades em `@{…}` (` end` no fim quando não tem Target); nó que o leitor não carrega
  inteiro (uma parte, valor ou propriedade que ele não lê): `X = opaque Kind @id`, só nome, chave e conector, intocável;
  chamada a uma action cujo nome outra ao lado também tem (a de cliente e a de servidor, as duas checagens de um role):
  `@{Call=Client}` ou `@{Call=Server}`.
- **Mapeamento de registros** (valor de uma atribuição ou de um argumento): `assign Destino = Origem mapTo { Campo: valor, … }`,
  `(System).ListAppendAll(List=L, SourceList=Origem mapTo { Campo: valor })`, com cada valor relativo ao registro (ou ao
  item, numa lista) de origem. Uma forma só nas duas faixas: no ODC é o texto da própria expressão; no O11 o mapeamento
  fica ao lado da expressão (a `TypeConversion` nativa) e o leitor o escreve igual (seção "Mapeamento de registros no O11").
  O mapeamento vazio (`Origem mapTo {  }`, a conversão que a plataforma faz sozinha: no ODC, uma lista de aggregate
  atribuída a uma lista da entidade) é o próprio valor: a leitura escreve `assign Orders = GetOrders.List` nas duas faixas
  (extrator 7) e a volta escreve o valor plano, também quando o texto traz `mapTo { }` (revisão da junção
  `feat/texto-ssam-2`; antes o ODC só aceitava `mapTo {  }` com dois espaços e o O11 o recusava no Verify).
- **Rótulo** `  # rótulo` antes do id. **Descrição** em linhas `///` acima do elemento, inteira. **Texto** (comentário,
  JavaScript, SQL) inteiro, linha a linha em `| `.
- **Propriedade sem palavra própria** numa linha `@{Nome=valor …}` logo abaixo do elemento: `True`/enum sem aspas,
  `"texto"` (JSON), `` `expressão` `` (com escapes), `&"nome"` (referência), `v"…"` (valor com espaço).
- **Expressões** do OutSystems como o Model API guarda. Uma expressão que não lê de volta inteira no seu lugar (quebra
  de linha, espaço na ponta, separador do lugar fora de string) sai entre crases com escapes `\n \r \t \\ \``.
  A impressora decide pela mesma leitura que o parser faz; nada é reinterpretado.

### Paginação, JOIN, SQL e exceções na autoria

Estas construções cabem no mesmo texto `ssam-flow/1`; não exigem trocar a action para JSON:

```text
  Pagina = aggregate FROM Cliente, Visita JOIN Inner Visita~Cliente ON Visita.ClienteId = Cliente.Id WHERE (Visita.ClienteId = ClienteId) SORT Visita.CriadaEm desc MAX PageSize START StartIndex
  Total = sql -> ResumoVisitas max 1
    in Cliente: Cliente Identifier = ClienteId
    | SELECT COUNT(*), SUM({Visita}.[Valor]) FROM {Visita} WHERE {Visita}.[ClienteId] = @Cliente
  end
  on exception All Exceptions:
    end
  on exception VisitaNaoEncontrada abort log:
    raise VisitaNaoEncontrada("Falha ao listar as visitas")
```

O JOIN canônico declara todas as fontes no `FROM`; cada ligação é `JOIN Inner A~B ON condição`, seguida de
` | Left B~C ON condição` quando há outras. `Inner` corresponde a **Only With**, `Left` a **With or Without** e `Full`
a **With**. A forma SQL (`FROM A LEFT JOIN B ON condição`) também entra: quando existe uma única leitura,
`FLOW_AGGREGATE_SQL_SHAPE` a normaliza, sem mudar os parênteses ou o texto da condição. Se a condição cita mais de uma
fonte anterior, ou não cita nenhuma entre várias fontes anteriores, a recusa lista os candidatos; não escolhe um deles.
Cláusulas repetidas de filtro, agrupamento, agregação, cálculo e ordenação são reunidas, e as cláusulas ficam na ordem
canônica. Dois `MAX` ou dois `START` continuam recusados porque não há um valor único a escolher.

Os parâmetros SQL ficam abaixo do nó `sql`, como `in P: Tipo = valor`; aceitam também `<Entidade> Identifier`.
Uma saída SQL nova referenciada como `Consulta.List.Current.Estrutura.Campo` recebe o nome dessa estrutura;
isso também vale para campos relativos de `Consulta.List mapTo { Campo: Estrutura.Campo }`.
O acesso legado `Consulta.List.Current.List.Campo` ou `Consulta.List mapTo { Campo: List.Campo }` conserva o membro
`List`. Textos entre aspas não escolhem o nome da saída. Saídas existentes mantêm seus nomes.
O handler vem depois do fluxo principal. `abort` e `log` são opcionais e correspondem a **Abort Transaction** e
**Log Error**; sem a palavra, a respectiva opção fica desligada. O leitor ordena os handlers pelo nome da exceção.
O texto também declara o nome nativo do handler, por exemplo `@{Name="AllExceptions"}`. No ODC, declara ainda
`@{MasterSource=&"Cliente"}` abaixo do aggregate com várias fontes. `MasterSource` é uma referência derivada e somente de leitura:
o escritor confere a asserção contra a árvore de fontes e JOINs; não tenta escrevê-la. Uma referência divergente é
recusada com `FLOW_AGGREGATE_MASTER_SOURCE`. Os exemplos do cartão trazem essas linhas na faixa ODC.

O mapeamento inteiro de um valor de atribuição ou argumento também funciona na forma JSON da op `logic`:
`"assign":{"Linhas":"Fonte mapTo { Campo: valor }"}` ou
`"args":{"List":"Linhas","SourceList":"Fonte mapTo { Campo: valor }"}`. A origem é uma expressão no escopo da action;
os valores dos campos são relativos ao item. `mapTo` dentro de uma condição, filtro ou ordenação continua
`EXPRESSION_SYNTAX`: só pode ocupar o valor inteiro de uma atribuição ou argumento.
No O11, o mapeamento completo que equivale à conversão automática por campos homônimos vira o valor puro e é listado
como `FLOW_MAPPING_PLATFORM`, tanto no texto quanto no JSON. Campos vazios ou trocados não são tratados como essa
normalização. A recusa de um For Each JSON traz o patch RFC 6902 de cada laço quando a substituição é certa e passa no
prévoo; aplique os patches na ordem devolvida, que preserva os índices quando uma chamada `ListFilter` é inserida.

## O que fica de fora, por regra

Lista fechada em `FlowRules` (`FlowExtract.cs`), contada por regra no armazenamento (`notWritten`):
- ruído do Model API (chaves, donos, posições, validade, descritores, `TransactionsManager` do ODC);
- estrutura: conectores (são as arestas), listas que repetem os filhos, a árvore de operações do aggregate;
- derivado: `Type` de parâmetro (vem do `DataType`), tipo de saída do aggregate e do SQL, tipo das colunas do aggregate,
  `ConcreteParameterType`, `NodesWithinCycle`, `SourceOperation`, os parâmetros implícitos do aggregate ODC,
  `MasterSource` com uma fonte só; duplicatas iguais (`IsFunction` = `Function`, `Shareable` = `Public`, `Comment` =
  `Text` no ODC); no O11, a conversão automática que o Studio deriva dos dois tipos (`ValueTypeConversion` com
  `IsUserVisible` falso: lista de SQL embrulhada na sua estrutura, registro de aggregate estreitado à entidade, registro
  cujos atributos o destino tem com os mesmos nomes) e a conversão com todos os atributos vazios (o Verify a recusa e o
  Studio a recria vazia);
- estado do editor: `AttributesInPreview`;
- padrões: valor igual ao padrão (`False` para booleano; `IsMandatory`, `AbortTransaction`, `LogError` = `True`;
  `AnimationEffect` = `None`, `Transition` = `Inherited`, `DateFormat` = `ISO`, `Fetch` = `AtStart`, `SortDirection` =
  `Ascending`). Os padrões são os valores que os dois Studios dão a um elemento novo, medidos em 11/10/2026 criando
  headless cada tipo de nó, parâmetro e action: todo booleano nasce `False`, menos os três acima e o `Public`/`Shareable`
  da service action, que nascem `True`. Por isso o `Public` da service action nunca sai como padrão: `True` é o `public`
  do cabeçalho e `False` vai em `@{Public=False}`.

Tudo o mais que um elemento guarda é propriedade do texto. Elemento que o leitor não reconhece, valor cujo texto não está
no dono, erro de leitura de propriedade, conector para fora da action: problema da action (ela não é ponto fixo).

## Ponto fixo

Para cada action: lê do modelo (forma canônica) → imprime → lê o texto de volta → mesma forma canônica e, impressa de
novo, o mesmo texto (`ModuleFlow.Check`). A forma canônica (`FlowItem.Canon`) compara ids (pela tabela), propriedades
autoradas, arestas e partes (atribuições, argumentos, casos, fontes, filtros, ordens, joins, colunas, saídas de SQL; em
conjunto onde a ordem não significa nada).

Medido em 11/10/2026 sobre os 34 módulos únicos do plano (`kernel/tests/fixtures/text-roundtrip/corpus.json`):

| | O11 | ODC | Total |
|---|---|---|---|
| Actions | 4.439 | 801 | 5.240 |
| Nós | 43.129 | 7.176 | 50.305 |
| Ponto fixo | 4.439 | 801 | **100%** |
| Textos cortados | 0 | 0 | 0 |
| Estrutura / digest (total) | 1,020 | 1,063 | 1,026 |
| Estrutura / digest (mediana por action; p90) | 1,076; 1,280 | 1,080; 1,322 | 1,077; 1,286 |
| Actions com a estrutura ≤ +25% | 84,7% | 85,1% | 84,8% |
| Tamanho / digest (total) | 1,213 | 1,563 | 1,260 |
| Tamanho / digest (mediana por action; p90) | 1,220; 1,729 | 1,437; 4,773 | 1,240; 1,907 |
| Actions com o texto inteiro ≤ +25% | 55,5% | 32,2% | 51,9% |

A estrutura (tudo menos `///`, comentários e `| `) fica em +2% (O11) e +6% (ODC) sobre o digest inteiro; o que ela
acrescenta é o id de cada linha (` @n12`, 7% do digest no O11). O resto do crescimento são as descrições e os textos
que o digest cortava em 160 caracteres ou não mostrava (descrições de parâmetros, de telas e de nós; comentários;
JavaScript; SQL): no ODC, só as descrições inteiras somam 33% do tamanho do digest e o código 13%. O critério do plano
("tamanho ≤ +25% do digest por action") vale no total e na mediana da estrutura; por action, ao pé da letra, não vale:
15% das actions passam de +25% só com os ids (actions curtas, em que `end` vira `end @n4`), e com os textos inteiros
metade passa (o texto que o digest cortava não pode sair cortado).

Com o dono no cabeçalho (12/10/2026: `action Tela.Nome`, `data action Tela.Nome`; extrator 5 na lane, 6 na junção), o
ponto fixo continua em 4.439 de 4.439 (O11) e 801 de 801 (ODC). O tamanho cresce só no cabeçalho das 2.648 screen e
data actions do O11 e das 620 do ODC: a mediana do texto inteiro sobre o digest foi de 1,220 para 1,246 no O11 (teto
1,25) e de 1,447 para 1,477 no ODC, cujo teto subiu de 1,45 para 1,50 por isso (`logic-expected.json`, `medianNote`);
a estrutura ficou em 1,028 e 1,075 (teto 1,25).

Os valores que a tabela 6.5 do plano lista como perdidos pelo digest aparecem todos, nas mesmas contagens (1.039
descrições longas de server action, 1.594 de parâmetros de entrada, 283 comentários, 189 JavaScripts, 278 tipos de
parâmetro de SQL, 179 rótulos de mensagem, 136 `SerializeDefaultValues`, 67 `Transition`...).

Teste: `kernel/tests/Shared/TextRoundTripTests.cs` (gramática sobre um módulo sintético, e o corpus por faixa em
`TextRoundTripCorpusTests`/`TextRoundTripCorpusOdcTests`, com as contagens esperadas em `logic-expected.json`). As
capturas não vão para o repositório: sem elas o teste avisa e volta.

```powershell
dotnet test kernel\tests\Anvil.Tests -c Release --filter "FullyQualifiedName~TextRoundTrip"      # O11, ~1,5 min
dotnet test kernel\tests\Anvil.Tests.Odc -c Release --filter "FullyQualifiedName~TextRoundTrip"  # ODC, ~40 s
```

## A volta (LG2)

### A chamada

```json
{"op":"logic","data":{"flow":[
  {"text":"<o texto lido de uma action, editado>","basedOn":"<o textSha dessa leitura>"},
  "<um texto sem @key no cabeçalho: uma action nova do módulo>",
  "<action Tela.Nome ou data action Tela.Nome sem @key: uma action nova daquela tela ou bloco>"
]}}
```

O kernel recebe um texto por action, vários textos numa op. Na entrada da fachada, várias actions novas num texto são
separadas antes de chegar ao kernel; uma leitura com `@key` nunca é dividida. Chamadas escritas com prefixo interno
`I<Kind>:` são normalizadas para o nome simples quando isso faz a linha passar no parser (`FLOW_KIND_PREFIX_DROPPED`);
literais e rótulos ficam intactos. Uma chamada ainda inválida não vira uma atribuição.

O nome de uma action nova é conferido também contra actions de entidade, do módulo e das referências. `NAME_COLLISION`
traz o elemento que ocupa o nome e um patch com nome livre; chamadas só acompanham o renome quando seus argumentos
identificam a action nova sem ambiguidade. Nome público faz parte da API: o autor pode escolher outro nome no patch.

No job do `o11_deliver` ou do `studio_deliver` do `ssam`, o `basedOn` é o
`textSha` que `ssam_map view:"flow"` devolve, e é obrigatório num texto com `@key` no cabeçalho: os ids do texto são da
leitura, e sem ela seriam lidos contra a action de agora (o que o Studio mudou depois seria desfeito sem aviso). Sem ele,
`FLOW_BASE_REQUIRED` traz o texto de agora e a edição pronta (`edit: {text, basedOn}`). Numa lista de um texto só, o
`data.basedOn` compartilhado vale para ele. Se a action mudou depois da leitura (no Studio, ou por outro job), o texto é
juntado em 3 vias com aquela leitura (seção "Merge de 3 vias", abaixo); sem a leitura guardada, `FLOW_BASE_CHANGED` traz o
texto de agora e a edição pronta. O recibo diz, por texto, os verbos aplicados, os elementos criados (com o id que o texto
deu), os removidos e renomeados, o `merged` do merge quando houve, e o texto como a action lê agora, com o `textSha` da
próxima edição. Num job, essa leitura (e a de agora que uma recusa devolve) fica guardada no armazém: a próxima edição
sobre ela é juntada se a action mudar de novo antes dela chegar.

### Identidade

- Linha com um id da leitura é aquele elemento (a chave fica). Linha sem id é elemento novo. Linha da leitura que sumiu é
  elemento removido. Um id da leitura escrito em outro tipo de nó é o nó antigo saindo e um novo no lugar (`recreated`).
- Parâmetro ou local renomeado no mesmo id é o verbo `rename`, que reescreve as expressões que o citam (nenhuma delas é
  escrita de novo). O nome de um nó é um `set Name`.
- Elemento novo só leva id quando precisa (alvo de `-> @x`, `end @x` repetido, comentário ligado): qualquer id fora do
  padrão da leitura (`n`, `p` ou `l` seguido de número), como `@x1`.
- Cabeçalho sem `@key` cria a action: `server|service|client action Nome` no módulo; `action Tela.Nome` (screen action ou
  action de bloco) e `data action Tela.Nome` (com as saídas e o fluxo de servidor que o texto escreve) sob a tela ou o bloco
  que o cabeçalho nomeia, uma tela ou bloco Reactive ou Mobile. Uma action nova é o texto inteiro: os nós e parâmetros que o
  Studio põe numa action nova (o comentário-modelo da service action, o `Out1` da data action) saem antes de o texto ser
  escrito. Ver "Screen, block e data actions pelo texto" abaixo.
- O dono de uma action lida é o da leitura: o texto pode escrevê-lo pelo nome ou pelo caminho, ou deixá-lo de fora (fica o
  mesmo); outro dono seria mover a action (`FLOW_ACTION_OWNER`).

### Diferença → verbos

| Diferença | Verbo |
|---|---|
| propriedade da action, de um parâmetro ou de um nó | `set` só dela (valor retirado do texto = o padrão da propriedade) |
| argumento de uma chamada | `set` do `Value` do argumento, pelo nome do parâmetro e na ordem dos parâmetros |
| partes de um nó (atribuições, casos, fontes, joins, filtros, grupos, colunas, ordens, saídas de SQL) | as iguais ficam; as outras são pareadas e reescritas por `set`; o que sobra de um lado é criado ou apagado |
| nó novo | `create`, valores e `link` com os vizinhos; o motor compartilhado organiza a action ao fim da transação |
| nó removido | `link` dos vizinhos, depois `delete` |
| ordem trocada | só `link` |
| parâmetro novo, removido ou em outra ordem | `create`, `delete`, `move` |
| parâmetro ou local renomeado | `rename` (reescreve o que o cita), antes de tudo; nomes que trocam de lugar, ou o de um parâmetro removido que outro toma, passam por um nome livre (nenhum `rename` toma um nome que outro ainda tem), e o removido sai no fim |

Actions novas e mudanças estruturais (criar, remover ou religar nós) passam pelo mesmo motor de layout das outras
formas de autoria, ao fim da transação. Alterações apenas de propriedades, valores, parâmetros ou nomes preservam
as posições existentes. O recibo `automaticLayouts` identifica as actions reorganizadas.

Os valores vão como o texto os tem: sem reescrita de expressão, sem formatação de SQL ou JavaScript, sem Max. Records
preenchido. Referências vão pelo nome que o leitor escreve e voltam para o único elemento com aquele nome para aquela
propriedade (o mais próximo da action quando há vários); `@{Call=Client|Server}` desempata a action de cliente da de
servidor. Uma referência nunca é um nó de fluxo (de qualquer action, inclusive a `OnException`), algo dentro dele, uma
parte da árvore de um aggregate ou um widget quando outro elemento tem o nome (um `navigate` se chama como o destino:
`RedirectToURL`, `Login`); o destino de um `navigate` é a tela ou o site externo, não uma action de mesmo nome. Uma action
criada por um texto da op e nomeada por outro é criada antes dele, seja qual for a ordem dos textos: a action que um nó
chama, o handler para onde vai um evento (`on AfterFetch -> Handler()`), a data action que um `refresh` busca e o evento
que um `trigger` dispara; o texto que preenche a casca de um documento `html` do job é sempre o que nomeia. Um nome que
não resolve sai com o ponteiro do seu texto (`FLOW_NAME_UNKNOWN`, `/data/flow/<i>`).

Depois dos verbos a action é lida de novo e tem de ser o texto: um valor que a plataforma mudou no caminho é escrito de
novo (`settled`), e o que ainda diferir recusa o job (`FLOW_NOT_EXACT`, com o trecho onde difere; nada fica). Um elemento
novo pode ficar com padrões do Studio que o texto não escreveu (`defaults` no recibo).

Dois limites da plataforma que o motor contorna, com a releitura como juiz:
- ODC: o leitor de texto da plataforma separa os campos de um mapeamento (`Origem mapTo { Campo: valor }`) em toda
  vírgula, inclusive dentro de `If(a, b, c)` ou de um texto `","`; o mapeamento que ela mesma imprime não volta
  ("Missing colon separator in mapping"). Quando isso acontece, o kernel monta o mapeamento pelas partes (a origem, cada
  campo e cada valor, todos lidos pela plataforma), separadas como a gramática do texto separa.
- ODC: um literal de registro num argumento genérico (`ListAppend` com `Element={ … }`) é escrito depois dos outros
  argumentos da chamada (o `List` dá o tipo) e montado com o tipo do argumento; sem tipo a plataforma o retipa enquanto
  preenche os campos e cai ("Cannot create an object under a deleted parent"). A ordem dos argumentos é a das entradas da
  action chamada (a ODC não guarda a lista `Arguments` nessa ordem).
- ODC: o valor de uma atribuição ou de um argumento guarda o mapeamento numa conversão própria (`ValueTypeConversion`, como o
  O11), que a plataforma lê para o texto do valor. Um `mapTo` ou um literal escrito como texto não era lido (o leitor de texto
  não lê nenhum dos dois) e a conversão antiga embrulhava o novo (`Src mapTo { novo } mapTo { velho }`): o kernel tira a
  conversão que há e escreve o valor inteiro pelo setter (a definição lida, com a conversão que ela diz). Editar um `mapTo`
  existente pelo texto (fonte, valor de campo, campos, tirar o mapeamento, trocar atribuições de lugar) funciona nas duas
  faixas (bateria `--kinds mapedit`).
- ODC: o mesmo leitor separa os campos de um literal de registro (`{ Campo: If(a, b, c), ... }`) em toda vírgula ("Missing
  colon separator in record field"). O kernel monta o literal pelos campos, cada valor lido pela plataforma, sem tipo
  (como a leitura da plataforma o deixa). Só um literal inteiro no seu lugar (um argumento, um valor); um literal dentro de
  outra expressão continua com o limite.
- Tipo `X Record List` (a lista do registro anônimo `{X}`, a saída de um aggregate): resolvido pela lista de mesmo nome que
  o módulo já tem; sem ela, o leitor de tipos ainda o lê como `X List`.

### Mapeamento de registros no O11

Até 12/10/2026 o texto do O11 não lia nem escrevia mapeamento campo a campo. Não era limite da plataforma: o Model API
público (`OutSystems.Model.V1`, as interfaces que o leitor percorre) não tem o mapeamento, mas o modelo do Service Studio
tem, em classes públicas de `ServiceStudio.Framework.dll` (o mesmo assembly de onde o kernel já usa `Entity.EntityIndices`):

- `Assignment.ValueTypeConversion` e `Argument.ValueTypeConversion` (as duas `IObjectWithTypeConversions`; a terceira é
  `SendEmail.AttachmentsTypeConversion`): uma `ServiceStudio.Model.TypeConversion` com `IsListConversion`,
  `SourceElementType`, `TargetElementType`, `UseImplicitConversion`, `IsUserVisible` e `AttributesMappings`;
- uma `AttributeMapping` por atributo do tipo de destino: `TargetValue` (o atributo) e `SourceValue` (a expressão de
  origem, relativa ao registro de origem, ou ao item numa lista), `SourceValue.SetValue(texto)` para escrever;
- a conversão não é filho do elemento (`IObjectSignature.Children`) nem propriedade de interface do Model API, por isso o
  índice, o digest e o leitor de fluxo nunca a viam (a auditoria "todo elemento abaixo da action é lido" não a pegava).

Medido headless no Service Studio 11.55.91 (sondas fora do repositório, `C:\t\tx3\probe`): o Studio cria a conversão
sozinho assim que o tipo do valor difere do do destino, com uma `AttributeMapping` vazia por atributo (o Verify recusa:
"Empty Mapping | Mapping cannot be empty", `ExpressionMissingTypeConversion`); preenchido um atributo, o Verify aceita;
os mapeamentos ficam quando o valor é reescrito com o mesmo tipo, quando `RefreshTypeConversions(true)` corre, e depois de
salvar e carregar. Um registro cujos atributos o destino tem com os mesmos nomes é convertido sozinho (cada atributo do
homônimo, `IsUserVisible` falso); mudar um valor torna o mapeamento do desenvolvedor (`IsUserVisible` verdadeiro), e
voltar cada atributo ao homônimo o torna automático de novo.

No corpus do plano (28 módulos O11) há 46 conversões (45 em atribuições, 1 num argumento), todas automáticas: 28 de
lista de SQL embrulhada na sua estrutura e 18 de registro de consulta estreitado à sua entidade ou estrutura; nenhum
mapeamento escrito por um desenvolvedor. Por isso a leitura nova não muda nenhum texto do corpus.

**Leitura** (`FlowExtractor`, `ModelReader.RecordMapping`, `Ss11RecordMappings`): o valor de uma atribuição ou de um
argumento com conversão `IsUserVisible` sai como `Origem mapTo { Campo: valor, … }`, os campos na ordem dos atributos do
destino e os vazios de fora: a mesma forma do ODC. A automática e a toda vazia não são escritas (contadas em
`notWritten`). Um mapeamento cujo texto não voltaria inteiro (valor com espaço na ponta, campo que não é nome) e uma
expressão do O11 que traz `mapTo` no próprio texto (o parser do O11 não o lê) deixam o nó opaco; um nó Send Email com
mapeamento de anexos do desenvolvedor (`AttachmentsTypeConversion`, que o texto não escreve) também. `ModuleFlow.Extractor`
passou a 5 na lane, a 6 na junção `feat/texto-ssam-2`, que junta o mapeamento e o dono no cabeçalho, e a 7 na revisão
dela (o mapeamento vazio do ODC sai como o valor). O armazenamento antigo, inclusive o de cada lane sozinha, não é servido.

**Escrita** (`Verbs.Mapping.cs`, o `set` de `Value` de uma atribuição ou de um argumento no O11): a origem vai para a
expressão e cada campo para a `AttributeMapping` do seu atributo; os outros atributos ficam vazios (o texto é o
mapeamento inteiro). Um texto sem `mapTo` sobre um mapeamento do desenvolvedor o retira: volta o do Studio (cada
atributo do homônimo) quando existe; senão os atributos ficam vazios e o Verify recusa o job. Os verbos crus e a op
`logic` em JSON não veem mapeamento: um `Value` sem `mapTo` escrito por eles não mexe no que está lá. A conversão segue os
dois lados: numa atribuição nova o `Value` chega antes do `Variable`, e numa atribuição existente o `Variable` pode mudar
o tipo de destino depois; o mapeamento que ainda não cabe espera e é escrito quando o outro lado chega. Atributo obrigatório
do destino deixado vazio (o `Id` de uma entidade) é o que o Verify recusa (`AttributeMappingRequiredExpression`): o
escritor recusa antes, com o valor que o preenche (`Id: NullIdentifier()`; o vazio do tipo nos outros). O que ao fim do
texto ainda não cabe recusa o job com o motivo (`FLOW_MAPPING_TYPES`): os mesmos tipos (nenhuma conversão), atributo que
o destino não tem (com a lista dos que tem), atributo duas vezes, ou o mapeamento que o Studio faz sozinho. A releitura
aceita os campos em outra ordem (ou outra caixa no nome do campo): é o mesmo mapeamento, lido na ordem do destino.
Testes: `kernel/tests/Anvil.Tests/FlowMappingTests.cs` (jobs reais no fixture em branco: ida e volta com o Verify válido,
edição de campos e de destino, as recusas, o registro que o Studio mapeia sozinho, e o laço T2 recusado com o patch
aplicado) e as regras do leitor sobre um módulo sintético.

**Bateria de mapeamento** (`anvil flow-battery --kinds map`, `FlowEdits.Map`; teste
`FlowBatteryCorpusTests.MappingEditsOfTheO11CorpusReadBackAsTheirText`, piso `o11Map` em `flow-battery-expected.json`):
como o corpus não tem mapeamento escrito, cada action do corpus O11 que tem um registro ou uma lista de um tipo de
registro (parâmetro, local, ou a lista de um aggregate de uma fonte) ganha uma local nova de outro tipo de registro do
módulo e um passo novo que a preenche por mapeamento, até três atributos do mesmo tipo (`assign Nova = Origem mapTo {…}`
ou `(System).ListAppendAll(List=Nova, SourceList=Origem mapTo {…})`, depois do aggregate quando a origem é a lista dele);
depois o mapeamento é editado (um campo a menos, um valor entre parênteses) e tudo é desfeito. Cada escrita passa quando a
action relida é o texto, letra por letra, com as chaves do que não foi tocado. Desde a revisão da junção todo atributo
obrigatório do destino entra mapeado (de um atributo do mesmo tipo da origem, ou o vazio do tipo: `NullIdentifier()` no
`Id`), a remap nunca o tira, e um destino com atributo de registro que tem obrigatórios próprios fica de fora: como o
escritor recusa o obrigatório vazio, uma escrita exata é uma que o Verify aceita quanto aos obrigatórios (antes, 164 das
575 escritas conferidas na revisão deixavam um obrigatório vazio). Medido em 12/10/2026 nos 28 módulos O11 (os mesmos
números na revisão):

| | Edições | Voltam exatas |
|---|---|---|
| map (891 atribuições, 435 `ListAppendAll`) | 1.326 | 1.326 |
| remap | 1.326 | 1.326 |
| desfeitas | 1.326 | 1.326 |

Verbos (na revisão): 5.743 `set`, 3.539 `create`, 3.978 `link`, 2.652 `delete`. 4.439 actions lidas; 1.326 tinham lugar para um
mapeamento (as outras não têm registro de origem que um outro tipo de registro do módulo receba em algum atributo do
mesmo tipo, ou, para uma lista, o módulo não chama `ListAppendAll` no seu tipo de fluxo). Na mesma cabeça: o ponto fixo continua
4.439 de 4.439 (O11; os 28 textos do corpus saem byte a byte iguais aos da leitura de `c4d71776`) e 801 de 801 (ODC), e a
bateria da LG2 continua 3.399 de 3.399 (O11) e 1.724 de 1.724 (ODC), com as reversões.

### Regras: uma recusa, com todos os problemas de todos os textos da op

| Código | Quando | O que a recusa traz |
|---|---|---|
| `FLOW_SYNTAX` | linha fora da gramática | a linha e a coluna; um problema por linha recusada, de todos os textos, na mesma recusa (seção "O que o motor normaliza no texto") |
| `FLOW_KEY_FOREIGN` | id que a leitura não deu; cabeçalho com a chave de outra action | elemento novo vai sem id; reler a action |
| `FLOW_KEY_ROLE` | id de um tipo de elemento escrito em outro | cada id fica no elemento lido |
| `FLOW_KEY_TWICE` | o mesmo id em dois elementos; dois textos da op editando a mesma action | |
| `FLOW_JUMP_UNKNOWN` | `-> @id` para um nó removido ou que o texto não tem | |
| `FLOW_SELF_LOOP`, `FLOW_BRANCHES_MEET` | ramo que volta ao próprio nó; dois ramos de um If ou Switch direto ao mesmo nó | |
| `FLOW_OPAQUE_TOUCHED` | nó opaco mudado, movido, removido ou escrito novo | a linha como foi lida |
| `FLOW_FOREACH_LIST_ACTION` | For Each novo que só filtra, copia ou mapeia para uma lista (T1/T2) | a List action (`text`) e o patch do job, conferido (abaixo; também quando o texto cria a action: a recusa do preflight traz o patch e o id) |
| `FLOW_JAVASCRIPT_NOT_ISOLATED` | nó JavaScript novo em qualquer action que não seja uma client action isolada e nomeada (decisão 6, L5) | num fluxo de cliente, o patch que leva o script para uma client action nova e a chama no lugar do nó; num fluxo de servidor, só a correção escrita |
| `FLOW_MAPPING_TYPES` | O11, na escrita: `mapTo` que não cabe nos dois tipos: os mesmos tipos ou tipos que não são registros (nenhuma conversão), atributo que o destino não tem, atributo duas vezes, atributo obrigatório do destino sem valor, ou o mapeamento que o Studio já faz sozinho (cada atributo do homônimo) quando não copia o destino inteiro de um registro do item (esse é escrito na forma da plataforma: `FLOW_MAPPING_PLATFORM`, abaixo). As duas faixas, na releitura: valor sem `mapTo` que a plataforma converte com um mapeamento que deixa atributo do destino vazio, e mapeamento que a plataforma não guarda (relê o valor sozinho) e que não é a conversão dela | o motivo, com os atributos do destino (e o valor do obrigatório: `Id: NullIdentifier()`; na releitura, os atributos que ficariam vazios e o mapeamento inteiro a escrever); todos os textos da op numa recusa; nada do job fica |
| `FLOW_MAPPING_TYPES` (ODC, no plano) | `mapTo` ou literal de registro que o texto escreve (novo ou mudado) e deixa vazio um atributo obrigatório do registro de destino (o tipo da variável atribuída, ou o item da lista de um `ListAppend`/`ListInsert`); o que a leitura já deixava vazio não conta | o patch que nomeia o obrigatório quando o valor é certo (`Id: NullIdentifier()`) e o módulo dá a ordem dos atributos; senão a correção escrita |
| `FLOW_MAPPING_CURSOR` | valor de um `L mapTo { ... }` que ainda lê `L.Current` (o item inteiro, `Place: Q.List.Current`, que não tem forma relativa; numa edição de uma leitura, todo valor novo ou mudado que lê `L.Current`) | a correção escrita; numa edição, o patch com o mapeamento relativo ao item quando ele existe (o que a leitura já tinha fica como está: decidido pelo conteúdo, o nó da mesma chave com uma atribuição da mesma variável e do mesmo valor, nunca pela posição; tirar, trocar ou pôr outra linha do bloco não toca nele) |
| `FLOW_RENAME_CAPTURED` | parâmetro ou local renomeado para o nome de um atributo da origem de um `mapTo` da mesma action que o cita (dentro do mapeamento os atributos da origem vêm primeiro: o texto voltaria igual e diria outra coisa). A origem é tipada pelo módulo (parâmetro, local, aggregate, a saída de uma chamada `GetX.Saida`, a lista de um SQL de uma saída, e o membro registro de qualquer um deles); a que o módulo não tipa conta com todo nome de atributo do módulo. Vale também para o verbo cru `rename` e para o renome que o Studio fez desde a leitura, lido no valor que a entrega escreveu (merge). Também: o atributo de uma entidade ou estrutura renomeado (verbo cru e texto de dados) para o nome de um elemento que um `mapTo` daquele registro lê num valor de campo (`Src mapTo { Key: Prefix + Code }` com `in Prefix`: depois do renome, `Src.Prefix`); e o alias de uma fonte de aggregate, novo ou renomeado, no nome de um parâmetro, local ou nó que as expressões da leitura daquele aggregate leem | um nome livre (no merge, a action de agora como edição pronta) |
| `FLOW_VALUE_RECORD_LITERAL` | ODC: literal de registro como valor de uma atribuição (a plataforma recusa: "Expression Value does not support record literals"). O11: qualquer literal de registro que o texto escreve (atribuição ou argumento): o parser do O11 não lê literal (só o editor do Studio o monta) | ODC: a atribuição campo a campo; o literal só como argumento. O11: uma local do registro, campo a campo, passada no lugar; ou `Origem mapTo { … }` |
| `FLOW_NOT_EXACT` (ODC, na escrita) | valor que a plataforma guarda como texto que não lê (`NotParsedExpression`: voltaria igual e o Verify recusa) | o valor numa forma que a plataforma lê |
| `FLOW_NODE_NAME_TAKEN` | nó existente renomeado para o nome de outro nó | o próximo nome livre (nó novo num nome tomado recebe o nome que o Studio daria, em `nodeNames`) |
| `FLOW_VALUE_REQUIRED`, `FLOW_VALUE_COMPUTED` | valor sem padrão retirado; valor que a plataforma calcula mudado sozinho (`IsAsynchronous` do JavaScript) | |
| `FLOW_ACTION_NAME_TAKEN` | texto sem `@key` com o nome de uma action do módulo, ou do dono numa screen ou data action (ou dois textos com o mesmo nome) | o texto atual daquela action, para editar |
| `FLOW_ACTION_KIND`, `FLOW_NEW_ACTION_KIND` | trocar o tipo de uma action; um tipo que o texto não cria | |
| `FLOW_NEW_ACTION_OWNER` | `action` ou `data action` nova sem o dono no cabeçalho | `action <Tela>.<Nome>` |
| `FLOW_OWNER_UNKNOWN`, `FLOW_OWNER_AMBIGUOUS` | o dono não existe (ainda: a tela que o job cria vem antes, no seu op `html`); o nome é de duas telas | os nomes mais próximos; o caminho `Fluxo/Tela` |
| `FLOW_OWNER_KIND` | dono Traditional (screen action ou data action nova só sob tela ou bloco Reactive ou Mobile) | |
| `FLOW_ACTION_OWNER` | o cabeçalho de uma action lida põe outro dono (mover é refatoração) | o dono da leitura |
| `FLOW_ACTION_FLAG`, `FLOW_SCREEN_ACTION_OUTPUT` | `public`/`function` numa screen ou data action; `out` novo numa screen action | |
| `FLOW_NOT_REPRESENTED` | action que não é ponto fixo do texto | op `logic` com `replace` ou verbos crus |
| `FLOW_BASE_REQUIRED` | texto com `@key` no cabeçalho sem `basedOn` | o texto atual (`text`) e a edição pronta (`edit`) |
| `FLOW_BASE_CHANGED` | a action mudou depois da leitura e a leitura não está guardada aqui (leitura antiga, outro armazém), ou o merge não sai como texto (um passo do Studio ficaria fora do fluxo) | o texto atual (`text`) e a edição pronta (`edit`: `{text, basedOn}` com o `textSha` de agora) |
| `FLOW_MERGE_REMOVED_USED`, `FLOW_MERGE_NAME_TAKEN` | o texto remove um parâmetro, local ou nó que o Studio passou a usar depois da leitura; os dois lados deram um nome a dois elementos diferentes | o texto atual e a edição pronta |
| `QUERY_IN_LOOP` (T3) | consulta dentro de um laço novo, decidida no candidato como para toda op | num fluxo de servidor, quando a correção é certa, o patch que lê o aggregate uma vez antes do laço e procura a linha com `ListFilter` dentro dele; senão a correção do candidato, com o ponteiro do texto |
| `AGGREGATE_SORT_NOT_ATTRIBUTE` | `SORT` (não `dynamic`) que não é UM atributo de uma fonte do aggregate (`Fonte.Atributo`) nem uma coluna dele: o compilador do OutSystems quebra nele (erro de publicação de 2026-10-12). Num aggregate que agrupa (`GROUP BY` ou `AGG`), só um atributo que o `GROUP BY` lê (`Fonte.Atributo`, ou a coluna `CALC` agrupada pelo nome): o sort vive antes do agrupamento e o SQL só ordena linhas agrupadas pelo que o `GROUP BY` dá (erro 8127). Só o sort que o texto muda é julgado (um sort antigo que um agrupamento novo deixa de fora também) | coluna `CALC SortKey=<expressão>` e `SORT SortKey`, ou sort dinâmico (expressão Text com o ORDER BY, `dynamic`); o patch é esse texto quando é certo (aggregate sem `GROUP BY`/`AGG` cujas linhas a action lê campo a campo: `X.List.Current.…`, `X.List.Length`, `X.Count`, `X.List mapTo {…}`). As formas certas não são recusadas: `X DESC`, `-X`, `(X)`, `IdentifierToLongInteger(X)` e `If(C, 0, 1)` são escritas como `X desc` / `C desc` e listadas em `sorts` e `expressionRewrites` |
| `AGGREGATE_COLUMN_NOT_ATTRIBUTE` | `GROUP BY` ou `AGG` sobre uma expressão (o mesmo slot que quebrou o sort; o Studio não escreve), ou coluna que não lê atributo nenhum (`AGG Total=Count()`: o parse recusa `Fn()`; `Count(``)`, a forma que a leitura imprime, é recusado pelo diff; Count com uma fonte só tem patch `Count(Fonte.Id)`) | coluna `CALC NomeRow=<expressão>` e a coluna pelo nome (`GROUP BY Nome=NomeRow`, `AGG Nome=Fn(NomeRow)`, a forma publicada); o patch é esse texto quando é certo (coluna com nome, funções que o banco roda, linhas lidas campo a campo; no ODC o texto não escreve aggregate agrupado, o patch fica para o op logic: `calculated` + `columns`) |
| `AGGREGATE_JOIN_NOT_NATIVE` | `JOIN` que não é `Inner`, `Left` ou `Full` (os três do Studio), join com fonte de outro aggregate ou com a mesma fonte dos dois lados (verbos crus), ou fonte de um aggregate de várias fontes que nenhum join liga | `JOIN Right A~B`, único join de duas fontes, não é recusado: é escrito `JOIN Left B~A` e listado (`joins`, `expressionRewrites`, `AGGREGATE_JOIN_NORMALIZED`); o resto: `Inner`/`Left`/`Full`, ou junte a fonte |

T1, T2 e T3 (`kernel/scripts/outsystems_padroes/RULES.md`) valem só para For Each novo; o que já existe é lido, editável e
fica como está (decisão 4 do plano):
For Each novo cujo corpo só testa, monta o elemento e o anexa a uma lista é **sempre recusado** (decisão 5), com o patch
quando a correção é certa e, quando não é, com a correção escrita (`fix` termina em `no patch: <por quê>`):
- T1, filtro: Ifs e o anexo num ramo só → `ListFilter` (com a condição negada quando o anexo fica no ramo falso) e
  `ListAppendAll`. If cujos dois ramos chegam ao anexo (ou nenhum) não é um filtro: recusa sem patch.
- T2, cópia: `ListAppend(Fonte.Current)`, ou de uma local que recebe `Fonte.Current` → `ListAppendAll`.
- T1/T2 sobre a linha de um aggregate: `ListAppend(Element=GetX.List.Current.Entidade)` (o registro da entidade da linha,
  não a linha) → `ListAppendAll` de `GetX.List` (ou do filtrado). O O11 converte a linha de uma entidade só nessa entidade; a
  ODC escreve a conversão, `SourceList=Filtro.FilteredList mapTo {  }`, só quando a lista é da própria entidade
  (`Entidade List`); escrito, o `mapTo {  }` é a conversão que a plataforma faz sozinha e a leitura o deixa de fora (volta
  `SourceList=Filtro.FilteredList`, como no O11). As fontes de um aggregate de tela e o tipo de uma lista da tela vêm do
  módulo (a aplicação os lê); sem eles, sem patch.
- T2, valor: `ListAppend(Element=Fonte.Current.Campo)` (ou uma expressão do item) → na ODC,
  `SourceList=Fonte mapTo { Value: Campo }`, quando a lista é de valores (`Text List`...); nunca um mapeamento vazio.
- T2, mapeamento: local montada campo a campo a partir de `Fonte.Current` e anexada → nas duas faixas,
  `SourceList=Fonte mapTo { Campo: valor }`, com os valores relativos ao item e os campos **na ordem dos atributos do
  registro** (a ordem em que a plataforma imprime; em outra ordem ela lê um segundo mapeamento e a action não volta exata); a
  local sai com o laço. Na ODC o mapeamento é o texto da expressão; no O11, o mapeamento nativo do argumento (seção
  "Mapeamento de registros no O11"), que nomeia todo atributo obrigatório do destino: o identificador que a local deixa vazio
  vai como `Id: NullIdentifier()`; outro obrigatório que o laço não preenche fica na correção escrita. O patch só vem quando
  diz o que o laço diz: a local é desta action, de outro tipo que o item (copiar alguns campos para o mesmo tipo não é
  mapeamento), nenhum valor lê a própria local e nada fora do laço a lê ou escreve; senão a recusa vem com a correção
  escrita e o motivo. Até a junção de 12/10/2026 o O11 não tinha escritor de mapeamento e esse laço era recusado só com a
  correção escrita.
- No O11 o texto não escreve mapeamento para uma lista de valores: o valor é recusado com a correção escrita
  (`ListAppendAll` com o mapeamento feito no Studio).
- Laço com limite (`foreach Fonte max 8:`) ou primeiro item (`start 2`) anexa só parte da lista; `ListFilter` e
  `ListAppendAll` tomam todo item: recusa sem patch, com o motivo (correção 2 da terceira junção: o patch perdia o `max`).
- Uma chamada sem nome leva o nome da action e o nome de nó é único: o segundo `ListAppendAll` de um mesmo texto (outro laço,
  ou um que a action já tem) vem no patch com o nome que o Studio daria (`ListAppendAll2 = (System).ListAppendAll(…)`), e o
  texto corrigido volta como foi escrito.
- Corpo que faz mais que isso (um total, uma flag, uma saída, uma chamada, um `ListAppendAll` que achata listas) é For Each
  permitido (T3: efeito ou decisão por item). Foi o caso do `ObterCarrinho` do Haiku_CS, que monta o item e acumula os totais.
- Num fluxo de cliente (client action, action de tela ou bloco), a condição do `ListFilter` lê os atributos do item direto
  (`Condition=Qty > 1`): o `ListFilter` de cliente nunca avança o `Fonte.Current` (regra do time). Condição que lê o item
  inteiro não tem essa forma, e esse patch não é certo.

### Patches conferidos (bloqueios B1 e B2 da conferência de 12/10/2026)

Quando a correção de um problema é certa, a recusa traz o **patch do job**, não só a linha: cada texto da op com as correções
certas dos seus problemas e, depois deles, os textos novos que elas pedem. O patch é um só por op e o mesmo em cada problema que
ele corrige: escreve o `data.flow` inteiro (ou o `data` inteiro, quando um texto único com `data.basedOn` vira lista: o
`basedOn` passa para o item), então aplicá-lo uma ou duas vezes dá o mesmo job. O `text` do problema continua com a List action.
Antes de oferecer, o motor lê o texto corrigido de novo, com a mesma leitura e as mesmas regras: ele não pode ter nenhum dos
problemas que corrige nem nenhum que o texto não tinha, e cada texto novo não pode ter problema nenhum. Correção que falha
sozinha sai (o problema fica com a correção escrita); as que passam vão juntas.

- **T1/T2**: o bloco do `foreach` (a linha, o corpo e o `next`) vira as linhas da List action, na profundidade dele; o nome
  do `ListFilter` é um que a action ainda não tem (`FilterPicked2` no segundo laço da mesma lista); um id que o texto deu ao
  laço passa para a primeira linha.
- **Decisão 6** (`FLOW_JAVASCRIPT_NOT_ISOLATED`): JavaScript existente é lido, editável e fica; nó JavaScript novo só numa
  client action isolada e nomeada (nome que não é o padrão `ClientAction1`, só nós JavaScript, comentários e assigns que copiam
  as saídas do script para as saídas da action). Em qualquer outra action, recusa. Num fluxo de cliente, o patch cria a
  client action com o nome do nó (o próximo livre, quando o módulo já tem uma action com ele), com as entradas e saídas do
  script, e troca o nó por uma chamada com o mesmo nome e os mesmos valores: `Nome.Saida` continua lendo. Num fluxo de
  servidor não há o que mover (servidor não roda JavaScript): só a correção escrita.
- **T3** (`QUERY_IN_LOOP`), num fluxo de servidor (lá o `ListFilter` lê `Fonte.Current`): aggregate novo dentro de um laço,
  ou aggregate dentro de um laço novo, com uma fonte só, sem join, grupo, coluna ou início, no máximo uma linha, escrito no
  bloco do laço e citado só dentro dele. O patch o lê uma vez antes do laço, com os filtros que não citam nada do laço, e põe
  no lugar dele um `ListFilter` com os outros filtros (`GetPais.List.Current.PcCountry.Label = ...`); as linhas do laço leem
  `FilterGetPais.FilteredList`. O resto continua com a recusa do candidato, agora com o ponteiro do texto. O escape
  `allowQueryInLoop` na op vale aqui também.

### Rodada do patch (revisão de 12/10/2026)

Recusa por uma regra do dono (T1/T2, decisão 6, T3, e as regras da página na op `html`) escondia o que o resto do job ainda
tinha de errado: o Verify da outra action da mesma op só vinha na segunda volta, depois do patch. E o patch era conferido só
pelo texto, nunca aplicado. Agora, antes de responder, o motor aplica o job de novo numa cópia nova da base, com todos os
patches da recusa escritos e os textos que nenhum patch corrige deixados de fora (com o que usa as actions deles), e roda as
fases e o Verify desse candidato (nada é salvo; se a rodada não puder rodar, a recusa fica como estava):
- problema de uma parte que nenhum patch mudou, e que a recusa ainda não diz, entra na mesma recusa com `afterPatch: true`
  (o ponteiro é o do job enviado: o Verify de um texto aponta `/ops/i/data/flow/j`);
- problema de uma parte que um patch escreveu (texto corrigido que não aplica ou não volta exato, erro do Verify sob um nó que
  a correção escreveu ou numa client action que ela criou) é do patch: o patch daquela op não é oferecido e cada problema dela
  diz por quê no `fix` (`no patch: applied to the job, the corrected op was refused: ...`).
O nome da client action que a decisão 6 cria evita todo nome de action do módulo e das referências (de tela e de bloco
também, que o Studio conta no escopo), de tela, bloco e fluxo.

### O que o motor normaliza no texto (VisitaCerta_CS, 12/10/2026)

A entrega do dono de 18 server actions em texto (VisitaCerta_CS, 15:38–15:41 UTC) levou 8 voltas: 7 recusas e a entrega.
Repetida offline pela CLI sobre a captura da sessão (`VisitaCerta_CS` de 15:35:11, produtor `VisitaCerta_IS` de 15:36:28), com
o código deste branch (`feat/tx-visitacerta`): o primeiro job volta **uma vez**, com os 18 erros do Verify que sobram (do
modelo: `Lower`, `Locked.Record.VisitStatusId`, `MorningConfig.Record.StartHour`, `Date > AddDays(...)`) e 30 normalizações
listadas; o mesmo job com esses 18 corrigidos é aceito. Os jobs 6, 7 e 8 da sessão passam como foram enviados.

**Toda linha recusada, numa recusa.** O parser parava no primeiro erro. Um texto recusado é lido de novo numa passada que
registra cada erro e segue depois da linha (e do bloco dela): `FlowSyntaxException.Errors`, o primeiro igual ao da leitura
estrita, e um `FLOW_SYNTAX` por erro (preflight, apply e merge). A leitura estrita de um texto que lê não muda (ponto fixo).

**Normalizações.** O que só tem uma leitura é reescrito antes das regras e listado em `normalizations` (`{rule, path, from,
to, message, line}`, o `path` é o do texto, `/ops/i/data/flow/j`), nunca recusado (`JobNormalizer.Pure` →
`FlowTextNormalizer`, `FlowTextNormalize.cs`; a passada leniente do parser, `FlowParser.Edits`, escreve as edições e elas só
ficam quando o texto editado lê inteiro). Um texto com outro erro vai como foi escrito e a recusa traz todos os erros dele;
os erros que uma edição certa remove vêm com o patch do op (o texto com essa edição, conferido: relido, sobram só os outros
erros; `FlowTextNormalizer.Corrected`).

| Regra | O que o texto tinha | Como fica |
|---|---|---|
| `FLOW_BRANCH_FALLS_THROUGH` | ramo cujo bloco termina sem terminador, só onde isso tem uma leitura (as duas leituras dizem o mesmo): corpo de For Each (vira `next`), fim do fluxo principal ou de um handler (vira `end`, também os casos de um Switch no fim) e ramo seguido de um `end` (`-> @jN` até ele, que ganha o id `@jN` quando não tinha). O ramo verdadeiro antes das linhas depois do If (o ramo falso) tem duas leituras, seguir para o ramo falso ou um `end` esquecido (if/else): continua `FLOW_SYNTAX`, nunca reescrito, com as duas leituras na correção e o patch conferido de cada uma em `candidates` (`FlowTextNormalizer.Ambiguities`). Também quando o último passo do ramo é um If sem passo falso (job 2, `GetWeatherForPlace` linha 34: "expected a line at depth 2, found depth 1"): o terminador esquecido seria o passo falso desse If, então o caminho falso dele segue para o ramo falso de fora ou termina ali (reconferência de 12/10/2026, sondas N26 e P13; a heurística antiga escolhia seguir). Ramo vazio continua erro |
| `FLOW_LABEL_SPACING` | rótulo depois de um espaço (`assign # PrepararLocal`, job 1) | `assign  # PrepararLocal`; um literal de data (`#2020-01-01#`) nunca tem espaço depois do `#` |
| `FLOW_ASSIGNMENT_INDENT` | atribuição um nível acima do bloco `assign` de cima, que nenhum passo lê e cujo valor não tem forma de linha de nó (`aggregate FROM`, `sql`, `JSONSerialize(`, `node`, `opaque`, em qualquer caixa; chamada com argumento nomeado como `CreateRec (Source=R)` ou `CreateRec (Source = R)`; uma função embutida das expressões, como `If(A=1, "x", "y")`, não é chamada) | atribuição do bloco; a linha de nó malformada continua `FLOW_SYNTAX` (também no patch conferido de outro erro) |
| `FLOW_NEW_ACTION_IDS` | id do padrão da leitura (`@n900`) numa action nova (job 1: 10 `FLOW_KEY_FOREIGN`) | `@xn900`: action nova não tem leitura, o id só rotula o elemento novo |
| `FLOW_MAPPING_RELATIVE` | `L mapTo { F: L.Current.X }` numa action nova (jobs 1 a 8), também dentro de uma expressão (`Trim(L.Current.X)`) e em várias linhas com o mesmo texto | `L mapTo { F: X }` em toda linha dos nós que o têm: todo `L.Current.` dos valores, fora de texto entre aspas, sai; o valor do mapeamento é relativo ao item, `L.Current` seria o cursor da lista. O que ainda lê `L.Current` (o item inteiro) é `FLOW_MAPPING_CURSOR`; numa edição de uma leitura quem decide é o apply, que conhece a leitura |
| `FLOW_SORT_DIRECTION` | `SORT X DESC` ou `X ASC` (job 4: 3 `ParserUnexpectedElement` e 2 `InvalidAggregateError`) | `X desc`, `X` |
| `FLOW_AGGREGATE_SQL_SHAPE` | JOIN na forma SQL, cláusulas repetidas ou fora da ordem canônica, com uma única leitura | fontes no `FROM`, ligações `JOIN Kind A~B ON condição` separadas por ` | ` e cláusulas reunidas na ordem `WHERE GROUP BY AGG CALC SORT MAX START`. Condições e valores permanecem literais; fonte esquerda ambígua e `MAX`/`START` repetidos são recusados com o motivo |
| `FLOW_MAPPING_PLATFORM` (as duas faixas, na releitura) | `Q.List mapTo {...}` (ou `Q.List.Current mapTo {...}`) que copia cada atributo do destino, com o tipo do destino lido do modelo, do homônimo de um registro do item (jobs 3 e 6) | a forma da plataforma: o valor sozinho quando a linha tem só esse registro, do tipo do destino (`{Place}` → `Place`, sem mapeamento possível), ou `mapTo { Value: Registro }` quando a plataforma mapeia o registro inteiro (`{WeatherForecast, WeatherForecastHour}` → `WeatherForecastHour`; uma estrutura que guarda o registro). O O11 escreve nessa forma (`IRecordMappings.Equivalent`; o registro de uma linha sem conversão, `FlushPendingMappings`); a ODC relê nela, e a equivalência é conferida pelos tipos do modelo, sem a API de mapeamento da faixa |
| `FLOW_MAPPING_STUDIO` (as duas faixas, na releitura) | valor sem `mapTo` que a plataforma converte com um mapeamento que ela mesma preenche (job 7, `FLOW_NOT_EXACT`: `Hours = Cache.List` relia `Cache.List mapTo { Value: WeatherForecastHour }`) | o texto passa a ler com esse mapeamento (o recibo traz o texto de agora), só quando ele preenche todo atributo do destino ou leva o registro inteiro: `Value: R` com um destino que não tem atributo `Value` e R registro do item (um alias da linha, ou um atributo de tipo registro da estrutura do item). O que deixa atributo vazio (`Rows = Q.List` com `VcRow{Name, Code}`: só `Name`; `Rows = S.List` com `VcValRow{Value, Code}`, que relê `Value: VcSetting.Value` e deixa `Code`, numa lista, num registro ou num argumento de List action) é `FLOW_MAPPING_TYPES` com os atributos vazios e o mapeamento inteiro a escrever |

O mapeamento que deixa um atributo de fora numa conversão automática, ou que mistura registros do item, continua
`FLOW_MAPPING_TYPES` com o motivo: no O11 a conversão dessas listas não tem mapeamento atributo a atributo (sonda da
`TypeConversion` na captura da sessão: `AttributesMappings` vazio na automática, só `Value` na de várias entidades). Na ODC
o mapeamento que a plataforma não guarda (`Cache.List mapTo { Value: P2 }` relê `Cache.List`) é `FLOW_MAPPING_TYPES` com o
motivo, não mais `FLOW_NOT_EXACT`; o que deixa um atributo do destino de fora e que a ODC completa sozinha pelo homônimo
(`Q.List mapTo { Id: NullIdentifier(), City: VcPlace.City }` relê com `Name: VcPlace.Name`) também, nomeando o atributo e o
valor que a plataforma pôs (no O11 o escritor recusa o obrigatório antes). Um texto que a releitura recusa não para os
outros da op: todos são escritos e relidos, e a op volta uma vez com os problemas de cada um. Na ODC um mapeamento escrito
sobre um valor que já existe (a edição de uma leitura, ou uma atribuição que muda de lugar no bloco) vai pelo setter, que
monta a conversão do texto inteiro; o `Text` do valor antigo guarda só a origem e recebia o mapeamento dentro dela
(`... mapTo { ... } mapTo {  }`, erro de sintaxe no Verify).

**Nenhuma troca de sentido calada (revisão de 12/10/2026).** A fachada deste branch ainda não repassa `normalizations` ao
modelo (isso chega com o pacote de velocidade, `1b26c2b4`, na junção 24-1). Por isso toda normalização daqui é de uma
leitura só, e o que tem duas é recusado com as duas: o if/else sem terminador (`FLOW_SYNTAX` com `candidates`, também
quando o ramo termina num If sem passo falso), a linha de nó malformada depois de um bloco `assign` (`FLOW_SYNTAX`), o
cursor `L.Current` que não tem forma relativa (`FLOW_MAPPING_CURSOR`) e o mapeamento da plataforma que deixa atributo vazio
(`FLOW_MAPPING_TYPES`, também quando o destino tem um atributo chamado `Value`). O switch: um Switch
termina o seu ramo (nada vem depois dele na cadeia), e os casos sem terminador seguem para onde o ramo segue depois do
bloco. A passada que junta os erros dá um erro por linha recusada: duas atribuições ruins do mesmo bloco são dois erros,
uma linha com indentação ímpar é lida um espaço mais rasa (um erro, não um a mais para a linha de baixo) e uma linha que a
recuperação encontra duas vezes (o bloco termina, depois ela não é passo) é um erro só.

**`VALIDATION_REFUSED` diz o que recusou.** As voltas 4 e 5 vieram da fase de build com o erro "job rejected by validation
contract; merge was not attempted", e o registro da tarefa (`ssam_task`) e a linha `end` do journal guardavam só código e
fase. O contrato é o do kernel (`JobRunner`): o Verify do candidato (`isValid` contra `expectedValid`), as expectativas de
mensagem (`accepted`), o contrato de dados e a prova do refactor. Agora o erro diz a parte que recusou com as contagens ("the Verify of the
candidate: 18 errors (ExpressionUnknownObject 15, ...); 18 messages no expectedMessages entry covers"; `Delivery.cs`
`ValidationVerdict` e `o11-build-phase.mjs` `validationContract`), a resposta traz `contract` e nunca uma lista vazia de
problemas (os do kernel, ou um por erro novo do Verify, `DATA_CONTRACT` por diferença do contrato de dados, `REFACTOR_PROOF`
pela prova do refactor, cada um com a correção que o resolve), e o registro da tarefa e o journal guardam o contrato e os
problemas por código. O mesmo vale para `o11_deliver until:'apply'` (que respondia só com `messages`; agora traz `contract`,
`problems` e o `failedOp` quando os erros nomeiam um op só, `o11-cycle.mjs` `contractRefusal`) e para a entrega recusada de
um `o11_access`. Candidato inválido só por erros que o módulo já tinha (nenhum erro novo: o erro está em
`validation.preexisting`, reconferência de 12/10/2026, sonda K1): o contrato diz "the module already had N errors (...), the
job added none" (`preexistingErrors`) e cada erro desses é um problema com o elemento e a chave, a corrigir no job ou no
Studio; nunca "0 errors" sem problema. E a recusa do próprio kernel no `until:'apply'` (`PREFLIGHT_REFUSED`, ou um código do
apply com problemas) volta como na fase de build, com todo problema e o patch de cada um, nunca `APPLY_FAILED` com o doctor.

Testes: `kernel/tests/Shared/FlowTextNormalizeTests.cs` (as duas faixas; as duas leituras do if/else, a linha de nó
malformada, o cursor em toda linha e o que fica, um erro por linha), `JobNormalizerTests` (os textos da op normalizados no
lugar; o patch conferido de um texto com outro erro; `candidates` do if/else; `FLOW_MAPPING_CURSOR`), `FlowVisitaCertaTests`
(jobs O11 reais no fixture em branco), `FlowApplyScenarios.AListMappingThatReadsItsListsCurrentMapsTheItem` e
`FlowApplyScenarios.AMappingThePlatformKeepsInItsOwnFormIsListedAndOneThatSaysSomethingElseIsRefused` (as duas faixas:
as formas da plataforma, o parcial e o não guardado recusados numa recusa, o cursor numa edição com o patch),
`APlatformMappingThatLeavesAnAttributeEmptyIsRefusedWhateverItsNames` (o atributo chamado `Value`, o obrigatório que a ODC
completa) e `AnEditThatLeavesAnExistingCursorMappingAsItWasKeepsIt` (tirar, trocar ou pôr outra atribuição do bloco; o
mapeamento editado na ODC) e `platforms/odc/facade/tests/tx-visitacerta.test.mjs` (também `until:'apply'`, `o11_access`, o
erro que o módulo já tinha e a recusa do kernel no `until:'apply'`).

Medido em 12/10/2026 no corpus do plano com este branch: ponto fixo do texto 100% (O11 e ODC) e dos dados (O11 e ODC);
bateria da LG2 e de mapeamento O11 100%; merge de 3 vias ODC 100% (lógica e dados) e O11 100% nos dados e 4.619 de 4.620 na
lógica. O caso que falta (DCIPS_Staff_Kiosk `TogglePause`, `changed-removed`: o JavaScript que o Studio removeu volta como nó
novo e a decisão 6 o recusa no texto juntado) e as baterias de criação (579 de 579 e 113 de 113 exatas, mas abaixo do piso de
screen actions porque 14 donos O11 e 1 ODC só têm modelos que as regras de JavaScript e For Each recusam) dão o mesmo resultado
com o kernel de `5a606386`, sem este branch. As correções da revisão (12/10/2026, à tarde) não foram medidas no corpus
(as baterias rodam na junção 24-1): as suítes filtradas, as sondas da revisão nas duas faixas e a repetição da sessão
(job 1 recusado uma vez com os 18 erros do modelo; o job corrigido e os jobs 6, 7 e 8 aceitos).

### Merge de 3 vias (`FlowMerge.cs`)

O texto que chega sobre uma leitura antiga não é mais recusado só porque a action mudou: ele é juntado com o que mudou,
como a tela já faz (`ScreenHtmlMerge`).

- **A leitura guardada.** Toda action que a `ssam_map view:"flow"` serve (sozinha ou numa lista) e que é ponto fixo deixa
  a sua leitura ao lado do arquivo de fluxo da captura: `<raiz do índice>\v1\<faixa>\<sha256>.kernel.flow-<textSha>.json`,
  com o texto, a tabela de ids e a chave da action (`FlowReading`, escrito pela fachada em `module-map.mjs` e pela CLI
  fria `anvil flow --action`). O nome é o próprio conteúdo: escrito uma vez. A aplicação acha a leitura pelo `basedOn`
  (`ModuleIndexStore.LoadFlowReading`), confere o esquema, o extrator e que o texto é daquele `textSha`.
- **As três versões.** Base = o texto da leitura (com a sua tabela de ids); theirs = a action como o módulo do job a tem
  agora; ours = o texto entregue, lido com a tabela da leitura. Tudo é casado pela chave do modelo, nunca pelo id (os ids
  renumeram): parâmetros, locais e nós pela chave; as partes de um nó uma a uma (revisão da junção, abaixo); antes, os grupos de partes
  (atribuições, casos, fontes, filtros…) inteiros.
- **A regra.** O que só um lado mudou vem desse lado (nome, propriedade, conector, grupo de partes, ordem dos
  parâmetros). Os dois mudaram diferente: conflito, fica a versão da entrega (regra do dono) e o conflito sai na lista.
  - Elemento que o Studio acrescentou depois da leitura nunca é apagado porque o texto não o tem.
  - Elemento que o texto removeu e o Studio mudou: removido, e listado.
  - Elemento que o Studio removeu e o texto mudou: escrito de novo como elemento novo (a chave antiga não existe mais), no
    lugar onde o texto o tem; os conectores que o texto mantinha para ele voltam para ele. Listado.
  - Renomear de um lado é renomear no merge: as expressões do outro lado são lidas com o nome final (o que o verbo
    `rename` reescreve). Vale para parâmetros, locais e nós que as expressões leem (`Nome.Output`).
  - Os dois lados inseriram passos depois do mesmo nó: ficam os dois, os da entrega primeiro e depois os do Studio
    (listado com `kept: "both"`). Se o Studio inseriu passos e a entrega mandou o conector para outro lugar, os passos do
    Studio ficam e seguem para onde a entrega manda.
  - Conector para um nó que não existe mais: vai para onde o lado que o removeu manda agora; senão, para onde ele seguia
    na leitura; se a entrega ainda vai para ele, ele é escrito de novo (listado).
  - O dono no cabeçalho (screen action, action de bloco, data action) não é editado pelo texto: o merge escreve o dono de
    agora (a tela renomeada no Studio depois da leitura), esteja ele na entrega como na leitura, pelo caminho ou de fora;
    outro dono é mover a action, e a volta o recusa (`FLOW_ACTION_OWNER`) como numa edição da leitura atual (junção
    `feat/texto-ssam-2`, teste `FlowMergeTests.TheOwnerIsTheActionsOwnerNowAndAMoveIsLeftToTheWayBack`).
- **O resultado** é o texto inteiro juntado, nos ids da leitura atual, que segue o caminho de sempre (`FlowDiff`): só o que
  a entrega mudou é escrito, e a action relida tem de ser esse texto. O recibo traz `merged`:
  `{merge:"three-way", basedOn, now, studio:<elementos do Studio mantidos>, conflicts?:[{key, id, element, what, studio,
  delivered, kept, note}], rule?}`. `studio` e `delivered` são o elemento como cada lado o escreve (a linha e as linhas
  dele).
- **As regras do dono julgam o texto juntado como julgam um texto** (junção dos bloqueios com os limites, 12/10/2026): T1/T2,
  JavaScript novo, T3 (com o escape da op), os nomes que um script movido não pode tomar e o que o módulo diz (tipos, fontes,
  atributos) valem sobre o texto juntado. A recusa traz o texto juntado (`merged`), e as correções certas são escritas nele:
  o patch manda esse texto com o `basedOn` de agora (ele já está sobre a action de agora e não é juntado de novo), e o job
  do patch é aceito com o que o Studio fez mantido (`AnOlderReadThatBreaksARuleIsRefusedWithThePatchOfTheMergedText`, nas
  duas faixas).
- **Revisão da junção `feat/texto-ssam-2` (12/10/2026): o que o merge passou a juntar e a recusar.**
  - **As partes de um nó, uma a uma** (antes, um grupo inteiro: duas mudanças em partes diferentes do mesmo nó viravam
    conflito e a do Studio se perdia). Cada parte da leitura é casada com a de cada lado: igual primeiro (na ordem, onde a
    ordem significa algo), depois pela identidade (atribuição pela variável, argumento pelo parâmetro, fonte e coluna pelo
    nome, join pelas fontes, ordenação pelo que ordena), o resto pelo lugar entre duas casadas ou pela semelhança. Cada parte
    casada é juntada como um elemento: propriedade a propriedade, o `Target` de um caso como um conector. Parte acrescentada
    por um lado fica; a mesma parte acrescentada pelos dois é uma; duas atribuições da mesma variável acrescentadas uma de
    cada lado: a da entrega, listada.
  - **Um valor que os dois mudaram é juntado por dentro quando dá**: um mapeamento (`Origem mapTo { … }`) ou um literal de
    registro campo a campo; um texto de mais de uma linha (SQL, JavaScript, descrição, expressão com quebra) linha a linha
    (diff3), com conflito só quando as mesmas linhas mudaram dos dois lados, ou os dois inseriram no mesmo lugar (ficam as da
    entrega, listadas com as do Studio); linhas vizinhas mudadas uma por cada lado ficam as duas. O conflito mostra o valor que
    vai ser escrito. Uma parte que um lado só moveu (um caso de switch em outra ordem) é a mesma parte.
  - **Correção 2 da terceira junção (12/10/2026)**: duas partes de identidades diferentes (outra variável, outro parâmetro de
    uma chamada apontada para outra action, outra ordenação) nunca são casadas, nem pelo lugar nem pela semelhança; as sobras
    são casadas pela semelhança com o par mais parecido primeiro. Uma parte sem identidade que a entrega mudou pouco e o Studio
    trocou por outra (pouco parecida) é do Studio removida e acrescentada: ficam as duas (a da entrega escrita de novo,
    listada). Chamada que um lado apontou para outra action enquanto o outro a mudou: a chamada inteira da entrega (action e
    argumentos), listada. `mapTo` cuja origem um lado trocou enquanto o outro mudou ou acrescentou campos: o mapeamento inteiro
    da entrega, listado (um valor de campo lê os atributos da origem primeiro). Linhas: um grupo só junta o que divide uma linha
    da leitura (ou inserções no mesmo ponto), então uma sobreposição de verdade não leva a linha do Studio que só encosta nela;
    em código (SQL, JavaScript, expressão), mudanças dos dois lados sem linha da leitura entre elas ficam as duas e são listadas
    com `kept: both` (a releitura não julga o que o código quer dizer).
  - **Renome dentro de um mapeamento**: o renome de um lado entra no valor de um campo de `mapTo` só onde o nome é o elemento
    renomeado, não um atributo da origem (tipada pelo módulo); quando o nome final é (ou pode ser) atributo da origem, o valor
    da entrega leria o atributo: recusa (`FLOW_RENAME_CAPTURED`).
  - **Nó que o merge escreve de novo** (o Studio removeu, a entrega mudou ou usa: id `+m1`) é da action, não novo: as regras
    de elemento novo (JavaScript da decisão 6, For Each da T1/T2, T3) não o julgam; a versão da entrega fica, listada.
  - **Passos do Studio no fluxo**: o passo que o Studio inseriu logo depois de um nó que a entrega remove ocupa o lugar dele
    (o que ia para o nó vai para o passo, e o passo segue para onde a entrega vai, listado); os passos que o Studio inseriu
    onde a entrega também inseriu, com saídas que se ramificam, seguem depois dos da entrega. Depois do merge, todo nó que o
    Studio tem no fluxo (alcançado do Start ou de um handler) e que a entrega não tirou do dela tem de continuar alcançado;
    senão o merge não sai (`FLOW_BASE_CHANGED` com a edição pronta): o passo do Studio nunca deixa de rodar sem aviso.
  - **Removido de um lado, usado do outro**: parâmetro, local ou nó de saída que o Studio removeu e que a entrega cita no
    que escreveu volta como elemento novo (listado); o que a entrega removeu e o Studio passou a citar recusa o texto
    (`FLOW_MERGE_REMOVED_USED`, com a edição pronta).
  - **Um nome, dois elementos**: os dois lados criaram um parâmetro ou local com o mesmo nome (sem diferença de caixa): um
    elemento só quando o papel e o tipo são os mesmos (os valores da entrega na chave do Studio, listado); senão, e quando
    um renome de um lado cai no nome que o outro lado deu (inclusive a nós lidos por `Nome.Output`), recusa
    (`FLOW_MERGE_NAME_TAKEN`). Um nome que só um lado repete continua dele (a chamada nova com o nome de uma que a action
    tem ganha o nome que o Studio daria, `nodeNames`).
  - **Renomes**: o renome de um lado não é lido no alias de uma fonte do aggregate (`FROM L=Line, Order`: `Order` ali é a
    fonte) nem no nome de campo de um mapeamento ou literal (`{ Total: … }`), como o verbo `rename` também não lê.
- **Sem a leitura** (leitura antiga, outro armazém, outro extrator), ou quando o merge não sai como texto: o comportamento
  de antes, `FLOW_BASE_CHANGED` com o texto atual e `edit: {text, basedOn}` pronto para editar e mandar; nada é escrito.
  Um id do padrão da leitura (`n`, `p`, `l` + número) que aquela leitura não deu é `FLOW_KEY_FOREIGN` contra ela.

Bateria do merge (`FlowMergeBattery`, `anvil flow-merge-battery --oml <captura> [--every N] [--disjoint N]`, também
`anvil-odc`): em actions reais, uma edição do Studio e uma do modelo sobre a mesma leitura. A do Studio é escrita primeiro
(a action passa a diferir da leitura); o texto do modelo, escrito sobre a leitura (guardada em memória como o armazém
guarda), passa pela op e é juntado; a action é relida.
- Disjuntas (nenhum elemento em comum, pela chave; tipos do `FlowEdits` em partes que a outra não toca): a action tem de
  ler como a do Studio com cada elemento que o modelo tocou como o modelo escreveu, sem conflito listado.
- Sobrepostas: a mesma expressão nos dois lados (`same-value`), nó que o modelo remove e o Studio mudou
  (`removed-changed`), nó que o Studio remove e o modelo mudou (`changed-removed`, volta com chave nova), passo inserido
  pelos dois depois do mesmo nó (`both-insert`). O conflito tem de vir listado com a chave do elemento, o lado da entrega
  fica, e todo o resto como o Studio deixou.
- Exato quer dizer: a action relida, no modelo canônico (toda chave, propriedade, parte e conector), é a esperada.

Medida em 12/10/2026 sobre o corpus do plano (semente 1; até 2 pares disjuntos e os 4 casos sobrepostos por action):

| | O11 (1 action em 6 de cada módulo) | ODC (1 em 2) | Total |
|---|---|---|---|
| Actions | 752 | 402 | 1.154 |
| Casos | 3.593 | 1.848 | 5.441 |
| Disjuntos: os dois lados ficam, nenhum conflito | 1.058 de 1.058 | 470 de 470 | **100%** |
| Sobrepostos: conflito listado pela chave, a entrega fica, o resto como o Studio deixou | 2.535 de 2.535 | 1.378 de 1.378 | **100%** |
| Sobrepostos por caso (same-value, removed-changed, changed-removed, both-insert) | 665, 615, 613, 642 | 355, 319, 319, 385 | |
| Disjuntos por par (Studio\|modelo) | expression\|expression 103, call\|expression 111, expression\|call 80, call\|call 82, branch\|expression 133, expression\|branch 107, call\|remove 106, remove\|call 78, remove\|expression 56, expression\|remove 63, swap\|expression 85, rename\|expression 29, expression\|rename 25 | 44, 47, 43, 47, 46, 47, 55, 36, 32, 35, 30, 6, 2 | |

O número de casos varia um pouco entre rodadas (no ODC, 1.845 a 1.848): depois de desfeito um caso que removeu um nó, o
nó volta com uma chave que a plataforma dá, e os casos seguintes daquela action são feitos sobre essa leitura. Todos saem
exatos em toda rodada; os pisos do teste ficam em cerca de 95% da medida.

Na revisão da junção a bateria ganhou os casos de um mesmo nó, que o merge de antes (o grupo de partes inteiro) perdia:
duas partes do nó, uma mudada de cada lado (`part|part`); a atribuição que o Studio acrescenta ao lado da que o modelo
muda (`insert|part`); duas linhas do código de um SQL ou JavaScript (`code|code`); e a mesma linha dele mudada dos dois
lados (`code-same-line`, sobreposto: fica a linha da entrega, listada). Medida no mesmo corpus e na mesma semente:

| | O11 (1 action em 6) | ODC (1 em 2) |
|---|---|---|
| Casos | 4.656 de 4.656 | 2.403 de 2.403 |
| Disjuntos / sobrepostos | 2.092 / 2.564 | 1.003 / 1.400 |
| part\|part, insert\|part, code\|code, code-same-line | 455, 551, 23, 23 | 224, 278, 24, 24 |
| Os casos de antes (same-value, removed-changed, changed-removed, both-insert) | 665, 618, 616, 642 | 355, 318, 318, 385 |

As baterias pegaram duas mutações feitas de propósito (o merge deixando de manter o que o Studio acrescentou): no Haiku_CS,
5 dos 12 casos de dados e os casos `branch|expression` de lógica falharam, como deviam. Na primeira rodada no O11, 2 casos `changed-removed` mostraram que um caso de
`switch` que ia para o nó removido no Studio não voltava para o nó escrito de novo; a regra dos conectores passou a valer
também para os casos (`Groups`), e a rodada final deu 100%.

Testes: `kernel/tests/Shared/FlowMergeTests.cs` (o merge puro sobre o módulo sintético), os cenários
`AnEditOfAnOlderReadIsMergedWithWhatChangedSince` de `FlowApplyScenarios.cs` (job real nas duas faixas, com o armazém) e
`MergeBatteryCorpus` (`MergeBatteryCorpusTests`/`MergeBatteryCorpusOdcTests`, pisos em
`kernel/tests/fixtures/text-roundtrip/merge-battery-expected.json`).

### Bateria (aceite da LG2)

Edições sintéticas de actions reais, cada uma escrita de volta pela op e lida de novo (`FlowBattery`): passa quando a
action lê exatamente o texto editado, impresso com os ids da leitura; os elementos que a edição não tocou ficam com as
chaves, e os novos com as que os `create` deram. Cada edição é desfeita do mesmo jeito (o texto de antes sobre a action
editada) e conferida igual. Tipos: expressão (um valor entre parênteses), chamada inserida, nó removido, ramo novo (um If
antes de um nó, com End no ramo verdadeiro), local renomeada (e as expressões que a citam), troca de ordem de dois nós.
Metade das linhas novas vai sem id, como o modelo escreve. A semente é estável (a mesma edição em toda rodada).

Medida em 11/10/2026 sobre o corpus do plano, com o código deste commit (`flow-battery` das duas CLIs):

| | O11 (1 action em 6 de cada módulo) | ODC (todas) | Total |
|---|---|---|---|
| Actions | 752 | 801 | 1.553 |
| Edições | 3.399 | 3.469 | **6.868** |
| Voltam exatas | 3.399 | 3.469 | **100%** |
| Desfeitas e exatas | 3.399 de 3.399 | 3.469 de 3.469 | **100%** |
| Por tipo (expressão, chamada, remoção, ramo, renomeação, troca) | 665, 642, 700, 722, 191, 479 | 709, 772, 709, 772, 103, 404 | |
| Verbos (set, create, link, delete, rename) | 8.617, 4.049, 9.837, 2.786, 382 | 7.937, 4.191, 10.002, 3.025, 206 | |

Exata quer dizer: a action relida, impressa com os ids da leitura (e os ids que o texto deu aos novos), é o texto
editado, letra por letra. Uma chave que mudasse fora da edição sairia como outro id e a edição falharia.

Na ODC, a mediana do tamanho por action sobre o digest foi de 1,437 (LG1) para 1,447: 9 actions de template
(`UpdateUser`, `SendResetPasswordEmail` e `SendChangeEmail`, em três apps) passaram a escrever `@{Call=Server}`, um fluxo
de cliente chamando a action de servidor cujo nome a de cliente também tem. Sem essa linha a volta escolhia a action
errada.

```powershell
anvil flow-battery --oml <captura> [--every N] [--seed S] [--kinds expression,call,remove,branch,rename,swap]
anvil-odc flow-battery --oml <captura> ...
dotnet test kernel\tests\Anvil.Tests -c Release --filter "FullyQualifiedName~FlowBatteryCorpus"       # O11, 1 action em 6
dotnet test kernel\tests\Anvil.Tests.Odc -c Release --filter "FullyQualifiedName~FlowBatteryCorpus"   # ODC, 1 em 2
```

Testes de regra: `kernel/tests/Shared/FlowEditTests.cs` (o diff puro sobre o módulo sintético) e
`FlowApplyScenarios.cs` (a op por um job real nas duas faixas: edição, regras, vários textos, action nova, service
action).

### Os dois pedidos de lógica do transcript de 10/10/2026

Repetidos offline sobre as capturas do Haiku_CS (o `apply` do kernel faz o que a entrega faz antes do merge):

| Pedido (10/10/2026) | No transcript | Pelo texto |
|---|---|---|
| "Criar Service Actions com checagem de role…" (04:43–04:46): a exceção `RegraNegocio` e 12 service actions | 128 s, 47 chamadas (quase todas leituras), 1 entrega | **2 chamadas**: a leitura do módulo (`ssam_map` digest, página 1: entidades, estruturas, roles) e 1 entrega com a exceção e os 12 textos sem `@key`. Aplicada sobre a captura de 04:43 em 6–8 s (máquina carregada), Verify sem erro; as 12 actions leem igual às da entrega JSON original (mesmo texto, menos a chave do cabeçalho) |
| "Restaurar implementação de Service Actions preservando chave" (05:11–05:17) | 326 s, 32 chamadas, 3 erros, **nenhuma entrega** (terminou num friction de lacuna: a gramática JSON só tinha `replace`) | **2 chamadas**: `ssam_map view:"flow"` com a lista das 12 actions (textos e `textSha`) e 1 entrega com os 12 textos editados (cabeçalho e parâmetros com os ids da leitura, corpo novo sem ids) e a exceção. Aplicada sobre a captura de 05:12 em 6–7 s, Verify sem erro; 12 de 12 chaves de action e 22 de 22 chaves de parâmetro preservadas; as 12 leem igual à implementação de 04:45. O mesmo job em JSON com `replace` (o caminho que o agente não achou) preservou só 8 das 12 chaves de action |

O job de texto tem o tamanho do JSON (21.092 B contra 20.041 B no pedido 1, minificados): o ganho é em voltas e em
identidade, como o plano previu (seção 7). Na primeira tentativa, a regra T2 recusou o `ObterCarrinho` (monta o item e
acumula totais num For Each); a regra foi estreitada para recusar só o laço que apenas filtra, copia ou mapeia, e esse
laço passou a ser permitido (T3). O script do replay fica fora do repositório (`C:\t\tx\lg2\replay\replay.py`), porque usa
as capturas.

## Screen, block e data actions pelo texto (12/10/2026)

Branch `feat/tx3-owner`. Antes, screen action, action de bloco e data action nasciam só pela op `logic` em JSON com
`owner`, e o texto editava as que já existiam. Agora o cabeçalho nomeia o dono, a leitura o imprime (é parte da forma
canônica: o ponto fixo continua em 100%) e um texto sem `@key` cria a action sob ele:

```
/// Conta uma escolha do pedido.
action FaShop.FaPick
  in OrderId: FaOrder Identifier
  assign Picked = Picked + 1  # Count the pick
  end

data action FaShop.FaGetTotals fetch=OnDemand
  out Total: Integer
  out Count: Long Integer
  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX 50
  assign
    Total = 0
    Count = GetOrders.Count
  end
```

- **Dono.** `action Tela.Nome` é screen action ou action de bloco (o dono diz qual); `data action Tela.Nome` é data action,
  com as saídas e o fluxo de servidor do texto (`on AfterFetch -> Handler(...)` e `fetch=OnDemand` como a leitura escreve).
  O dono é a tela ou o bloco pelo nome, sem distinguir caixa, ou pelo caminho `Fluxo/Tela` quando o nome é de dois
  (`FlowOwners`, o mesmo índice que a leitura usa para escrever). Só telas e blocos Reactive ou Mobile, nas duas faixas;
  um dono Traditional é recusado (`FLOW_OWNER_KIND`, decisão 7), e as actions Traditional que já existem continuam
  editáveis.
- **Criação.** O `create` vai sob o dono (screen action Mobile, ou `IDataAction`); o que o Studio põe numa action nova
  (Start e End, o `Out1` da data action) sai antes de o texto ser escrito; depois vale tudo da volta: verbos, releitura
  exata, `settled`, `defaults`. O recibo traz `owner`, `new` e as chaves (`keys`).
- **No mesmo job da tela (op `html` de documento).** O documento nomeia as actions em `actions="A"` e
  `data-actions="D"`; os textos `action Tela.A` e `data action Tela.D` de um op `logic` depois do `html` as declaram. A
  screen action nasce antes do conteúdo como casca (nome e inputs, Start e End), para os eventos ligarem; o texto sem
  `@key` que a nomeia é a edição da casca (a chave e os inputs ficam, pelo nome; recibo `filledShell`). A data action nasce
  do texto depois do documento. Documento recusado leva as cascas embora e o texto volta a ser uma criação.
- **Regras** (uma recusa com todas, como as outras): `FLOW_NEW_ACTION_OWNER` (sem dono), `FLOW_OWNER_UNKNOWN` (com os
  nomes mais próximos), `FLOW_OWNER_AMBIGUOUS` (com o caminho), `FLOW_OWNER_KIND`, `FLOW_ACTION_OWNER` (o texto de uma
  action lida não a move: mover é refatoração), `FLOW_ACTION_FLAG` (`public`/`function`), `FLOW_SCREEN_ACTION_OUTPUT`
  (screen action não tem saída), `FLOW_ACTION_NAME_TAKEN` (o nome já é de uma action do dono: o texto dela é o patch).
  T1/T2 valem como para toda action nova.

### Bateria de criação

`FlowCreateBattery` (corpus em `FlowBatteryCorpus.RunCreate`, CLI `flow-create-battery --oml <captura> [--every N]`):
para cada tela ou bloco do corpus que tem screen ou data actions (um em cada `every`), uma action nova de cada um desses
tipos, escrita pela op de texto: o texto da primeira action daquele dono e tipo que é ponto fixo sem nó opaco, com outro
nome, todo id trocado por um id que nenhuma leitura dá e, em metade dos donos (pela semente), sem os ids que nada aponta,
como o modelo escreve. Passa quando a action nova lida de volta é exatamente o texto, com as chaves que os `create` deram.
Um modelo que as regras do dono recusam como action nova (For Each que só filtra, T1) dá lugar ao próximo, contado em
`rules`; uma saída de data action com o nome de um elemento da tela (a cópia ao lado do modelo colidiria) também.

Medida em 12/10/2026 sobre o corpus do plano, todos os donos (`every` 1):

| | O11 | ODC | Total |
|---|---|---|---|
| Donos (telas e blocos com screen ou data actions) | 428 (424 Reactive ou Mobile) | 110 | |
| Donos Traditional (fora) | 4 | 0 | |
| Screen actions criadas / exatas | 408 / 408 | 110 / 110 | |
| Data actions criadas / exatas | 183 / 183 | 4 / 4 | |
| Total exato | 591 de 591 | 114 de 114 | **705 de 705 (100%)** |
| Modelos pulados pelas regras (T1) | 20 (e 2 saídas com nome da tela) | 0 | |

Na mesma rodada, com o código desta branch, o ponto fixo continua em 4.439 de 4.439 e 801 de 801, e a bateria de edições
da LG2 em 3.399 de 3.399 edições e desfeitas (O11) e 1.724 de 1.724 (ODC).

A bateria achou quatro coisas que a edição de actions não exercitava (corrigidas, e valem também para a edição):
- uma referência resolvia para um nó de mesmo nome (um `navigate` se chama como o destino, `RedirectToURL`, inclusive no
  `OnException`), para uma fonte de aggregate ou para um widget: esses nunca são o alvo quando outro elemento tem o nome;
- o destino de um `navigate` ficava ambíguo entre a tela `Login` e uma action `Login` (do bloco ou do `(System)`): a tela
  ou o site externo vence;
- ODC: literal de registro com vírgula dentro de um valor (`{ A: If(x, 1, 2) }`) não era lido pela plataforma: o kernel o
  monta pelos campos;
- tipo `X Record List` (saída de aggregate) virava `X List`: a lista de mesmo nome do módulo é usada.

```powershell
dotnet test kernel\tests\Anvil.Tests -c Release --filter "FullyQualifiedName~NewScreenAndDataActions"       # O11, ~3 min
dotnet test kernel\tests\Anvil.Tests.Odc -c Release --filter "FullyQualifiedName~NewScreenAndDataActions"   # ODC, ~1 min
```

Suítes completas na mesma branch, com ambiente isolado (`ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`, `SSAM_NO_WARM=1`):
Anvil.Tests (O11, sem os três testes de corpus acima) 2.936: 2.883 ok e as 53 falhas de ambiente da junção (52
`ScreenCoverageTests` sem as fixtures do OutSystems UI, 1 `FunctionCatalogTests`); Anvil.Tests.Odc 966: 965 ok, 1
ignorado; fachada, os 14 arquivos do discover, do MCP, do fluxo e das rotas de texto: 139 de 141, as 2 leituras com
captura que pedem a chave da bridge (iguais na junção); as 160 respostas das rotas de texto seguem dentro de 40 KB.

Testes: `FlowEditTests` (cabeçalho, ponto fixo com o dono e com o caminho, criação e regras sem módulo) e
`FlowApplyScenarios` nas duas faixas (`ScreenBlockAndDataActionsAreBornFromTheirTexts`: uma de cada tipo, relidas iguais
ao texto com as chaves, editadas, e as recusas; `TheDocumentAndTheFlowTextsOfOneJobBindAndFill`: o documento e os textos
no mesmo job; `ATraditionalOwnerIsNotWrittenByText`, O11).

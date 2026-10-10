# Autoria C# de Data e Logic

Status: implementação em desenvolvimento. A publicação **4957** de `ZZHighCodeLab_CS`, no ambiente pessoal, passou **480/480 verificações HTTP**: 396 regressões e 84 casos de consultas/grupos/médias escritos por agentes frios. As oito divergências de ordenação/paginação da versão 4948 foram corrigidas, mantendo fontes e expectativas originais. Essa bateria não demonstra suporte universal a C# nem encerra Data/Logic. A instalação nas faixas, o pacote de runtime final e a cobertura restante ainda estão pendentes.

Marco de 2026-09-08: recursão nativa, helpers de instância e controle de exceções com filtros antes de `finally` estão integrados, com identidades de exceção compartilhadas por transporte ABI3. Os 12 casos originais passaram no CLR/probe e na geração/Verify/recarga/merge. A publicação de laboratório **5035** encontrou uma diferença real: 7/12 respostas passaram pelo SDK; cinco continham exceções inalcançáveis. Capturar o tamanho de cada arena antes de executar a fonte corrigiu a reprodução com listas compartilhadas. A versão **5036** passou **12/12 casos ao vivo pelo SDK estrito**, com fonte, expectativas e runtime preservados. Evidências em `.local/data-logic-translator/shared-arena-progress.json` e [arquitetura de exceções](architecture/2026-09-08-csharp-exception-control.md). A entrada padrão e a prova de uso cego permanecem separadas dessa execução staged.

Aritmética decimal em contexto com referências agora retorna a falha da primitiva ao ponto original da chamada, permitindo filtros e `finally` na ordem C#. São 18 testes focados, incluindo overflow, divisão por zero, avaliação única e uma action escalar pela entrada pública comum. A prova nativa do fixture decimal tem oito endpoints e 16341 asserções, sem mensagens no Verify, com recarga/merge/repetição. Essa fronteira é estritamente aritmética; não implementa adaptação geral de falhas de banco, serviços ou rollback.

A entrada padrão para todos os objetos e coleções ainda está em convergência: o perfil de grafo não foi ativado globalmente. `IReadOnlyList`, arrays de bytes, argumentos opcionais e codecs temporais estão integrados nesse perfil. A fonte combinada de seis endpoints passou 9.089 asserções nativas e **18/18 chamadas HTTP pelo SDK ABI4**, mais autenticação inválida, no laboratório `ZZBoundaryComposition_CS` versão **5043**. Foram verificadas omissão real de chaves JSON, distinção de null explícito, aliases entre views e listas/arrays, casts, mutações antes de exceção e DateTime/DateTimeOffset exatos. O frontend integrado passou 1.107 testes, com seis lacunas antigas ignoradas. As provas dos cinco tipos temporais no modelo continuam separadas dessa publicação, que exercita dois deles. Evidência: `.local/data-logic-translator/boundary-composition-progress.json`; contratos em [valores temporais](architecture/2026-09-08-csharp-temporal-graph-abi.md), [views de listas](architecture/2026-09-08-csharp-readonly-list-views.md) e [argumentos opcionais](architecture/2026-09-08-csharp-optional-arguments.md).

O recorte de arrays preserva a identidade de `byte[]` em argumentos, campos e retornos, inclusive aliases e mutações antes de uma exceção. A dimensão é avaliada uma vez e valores negativos ou acima do domínio Int32 falham antes da alocação, com mensagens CLR distintas de long e uint. A fixture de quatro endpoints usa o contrato ABI2 existente, com 4.603 asserções nativas, Verify sem mensagens, recarga/merge e plano repetido vazio em 13,28 s; a publicação combinada 5043 exercita bytes, mas não transforma todo array em capacidade comprovada. Os defaults iniciais passaram para bytes, strings, int?/DateOnly? e os tipos fonte daquele teste. Uma auditoria posterior encontrou lacunas em char e estado privado/NotMapped de structs, com correção comum de defaults ainda isolada. Persistência `Binary Data` é recusada explicitamente até existir codec; capacidade máxima/OOM permanece sem prova. Evidência histórica: `.local/data-logic-translator/byte-array-progress.json`.

A re-medição da ativação automática preservou as fontes e identificou seis rejeições reais, causadas pela materialização de resultados de consultas agrupadas para arenas. A primeira correção dessas consultas permanece isolada: uma auditoria executando o SQL em SQLite em memória encontrou quatro divergências de ordem de efeitos e avaliação além de FirstOrDefault/Take. É necessário compor a enumeração posterior ao GroupBy, em vez de executar cada Where/Select como uma passagem completa. Relatórios: `.local/data-logic-translator/automatic-graph-remeasurement/MEASUREMENT.md` e `.local/data-logic-translator/grouped-query-independent-audit/REPORT.md`.

A migração do caller dos testes temporais manteve todas as fontes e asserções, alterando apenas o adaptador de invocação. Ela revelou 12 falhas reais na presença do texto produzido pelo formatter. O helper TextPayload, comum ao formatter e Trim, corrigiu essas falhas e foi integrado: frontend 1.112 aprovados e seis skips, cinco novos testes focados, quatro endpoints nativos com 2.748 asserções sem erros de Verify/recarga/merge/repetição. Na cópia com seleção automática, 120/127 testes temporais passaram; sete ainda exigem diagnósticos antigos e estão em migração. Evidência: `.local/data-logic-translator/temporal-caller-progress.json`. Não confundir esta prova de modelo com a publicação anterior 5043, nem classificá-la como ativação pública global. Imports, uso cego, transações/efeitos externos e as demais lacunas abrangentes continuam abertos.

A fonte é C#. O Hybrid cuida dos tipos nativos, identificadores, declaração de dependências internas, parâmetros, nós, conexões, autorização, comparação com o módulo existente e recibo de entrega. A fonte não contém expressões OutSystems nem um manifesto separado de bindings.

A ordenação ordinal após agrupamento usa uma primitiva tipada própria, adquirida pelo controlador e congelada na tarefa por artefato, assinatura e identidade/ABI. O fluxo foi provado com a fonte original, sem instruir o autor a descobrir chaves ou criar bindings. O restante da consulta, incluindo os cálculos decimais, continua em lógica nativa. A fonte foi entregue pelo recibo `ac87581e619f45d5861bbdb4eade467a`; os fixtures de execução, por `89f9a8f97d444aa894dfc48fe2569ee2`. Prova com hashes em `.local/data-logic-translator/native-execution-v4957.json`.

A prova isolada anterior da primitiva, na publicação 4951, teve **400/404 HTTP**: Unicode válido passou, mas quatro entradas com surrogates isolados divergiram no transporte. A bateria verde de 480 não elimina essa lacuna separada. Ordenação por cultura também não é silenciosamente convertida em ordinal. Decisão, aquisição e limites em [ADR-019](adr/ADR-019-typed-framework-primitives.md).

O ambiente de compilação fornece os imports implícitos usuais do SDK .NET (`System`, coleções, LINQ, IO, HTTP e threading/tasks), sem editar os arquivos autorados. Imports disponíveis não significam tradução de todas as APIs desses namespaces. Comparadores não reconhecidos são diagnosticados; reconhecer uma assinatura não comprova sua equivalência semântica.

```csharp
using System;
using System.ComponentModel.DataAnnotations;
using Anvil.Authoring;

public enum Stage { Received = 10, Ready = 40 }

[Entity, Index(nameof(Code), Unique = true)]
public sealed class Sample
{
    public Id<Sample> Id { get; set; }
    [MaxLength(24)] public string Code { get; set; } = "";
    public Stage Stage { get; set; } = Stage.Received;
    public decimal? Measurement { get; set; }
}

public record Price(decimal Gross, decimal Total);

public static class Prices
{
    [ServiceAction]
    public static Price Quote(int count, decimal unitPrice, decimal freight)
    {
        if (count <= 0) throw new ArgumentException("Count must be positive.");
        var gross = count * unitPrice;
        return new Price(gross, gross + freight);
    }
}
```

Classes/records com `Entity` são entidades persistidas; records de transporte são structures. Enums viram catálogos fixos e conservam os códigos explícitos em atributo próprio, sem confundir o código C# com o AutoNumber da plataforma. Referências usam `Id<T>`. Comprimentos e índices usam metadados pequenos, com `nameof` normal de C#.

Na lógica, um enum conserva o valor numérico do tipo subjacente, inclusive casts para valores não declarados. Na persistência, uma propriedade enum é uma FK para a Static Entity: o compilador converte código/identidade nas duas direções e valida a pertença ao catálogo ao gravar. Consultas sobre enums comparam e ordenam o código C#, não o AutoNumber. Isso preserva a integridade da tabela sem limitar os valores possíveis em cálculos e decisões na memória.

Métodos estáticos concretos viram server actions. `ServiceAction` escolhe a fronteira remota. Métodos públicos recebem autenticação no servidor; `Authorize("Supervisor")` acrescenta a role. Helpers privados continuam privados e chamadas são resolvidas pelo símbolo, inclusive quando o helper aparece depois ou tem overloads. A falta de uso de helpers/contratos continua sujeita aos diagnósticos do módulo.

Essa entrada C# ainda não oferece autoria de client actions. A cobertura de client actions no backend declarativo anterior não comprova sua tradução por este frontend. O fechamento abrangente de Logic também exige a entrada JavaScript de client/screen actions, com suas provas; os resultados de C# para servidor não encerram esse requisito. Essa frente pode ser coordenada com o tradutor de Interface, preservando o critério de conclusão.

O recorte atual de Logic traduz parâmetros e retorno tipados, variáveis locais, atribuições, aritmética inteira/decimal, condições, curto-circuito, ternário, `for`, `while`, `foreach`, `break`, `continue`, retorno antecipado, lançamento de exceção e construção de records de transporte. Cada capacidade ainda precisa da prova semântica no servidor, além da prova estrutural já executada. Os limites de tipos, operações e efeitos não implementados são erros na localização C#; não há fallback para executar a fonte arbitrariamente.

`IDataSession` fornece `Query<T>()`, `Insert`, `Update` e `Delete`. É uma dependência de requisição recebida pelo método C#, sem virar um parâmetro de negócio da action nativa. A consulta usa LINQ normal; `Where`, `OrderBy`, `First`/`Single` e suas variantes opcionais, `Any`, `Count` e materialização em lista já têm tradução. Records persistidos podem ser criados por construtor e atualizados com `with`; a conversão entre o record lógico e os campos físicos fica no compilador. O fluxo de estoque escrito pelo agente frio foi compilado sem mudanças na fonte e executado no servidor: cadastro com nota nula, leitura em outra requisição, atualização com nota vazia, nova leitura e exclusão. Consultas mais amplas, concorrência e evolução persistida continuam exigindo provas próprias.

`Select` escalar/record, `Join`, `GroupBy` com projeção de chaves/agregados, `Skip`, `Take` e `ThenBy` usam um modelo relacional tipado compartilhado. Projeções intermediárias anônimas, filtros antes/depois da projeção, coalesce, nulidade e ordem dos operadores são preservados. Cinco métodos escritos por agente frio, com 28 casos e expectativas independentes em .NET, passaram no banco do OutSystems: os fixtures substituem somente as tabelas de entrada das queries geradas, e a prova compara os resultados completos, ordenados, com decimais e IDs grandes. Há também Verify/recarga de 18 métodos de paginação e 18 consultas em SQLite. Isso não comprova todas as combinações ou equivalência universal de collation, overflow e arredondamento SQL/C#. A criação de listas/arrays por inicializadores e o acesso a referências opcionais também são traduzidos, incluindo a exceção de referência nula.

`string.IsNullOrEmpty`, `IsNullOrWhiteSpace` e `Trim`/`TrimStart`/`TrimEnd` sem argumentos têm tradução. Os 25 caracteres de espaço Unicode usados pelo .NET e caracteres invisíveis que não são espaços foram testados no servidor. Controles e separadores de linha em constantes usam uma representação que conserva seus valores no modelo e no código gerado. Falhas independentes nas assinaturas ou nos corpos dos métodos são reunidas por etapa, sem retornar contrato parcial.

`switch` como instrução/expressão, labels compartilhados, null, padrões constantes/relacionais, `and`/`or`/`not`, variáveis ligadas por padrão e guards `when` possuem tradução, prova de Verify/recarga e os casos executados na versão 4944. O seletor é avaliado uma vez; guards só executam quando seu padrão é alcançado; `break` sai da seleção mais próxima e `continue` alcança o laço. O `foreach` aplica o codec tipado ao item, e uma consulta materializada dentro de um laço começa com uma lista vazia em cada avaliação. Padrões recursivos/de lista, polimorfismo e `goto case/default` ainda estão incompletos.

`DateOnly` e `TimeOnly` já têm representação própria de valor: número de dias gregorianos e ticks de 100 ns, respectivamente. O recorte traduz construção, limites, componentes, comparações/anuláveis, `DateOnly.AddDays`, formatos numéricos invariantes e operações selecionadas de horário com conversão comprovadamente exata. Os 60 testes temporais locais comparam fluxo emitido com o CLR; a suíte completa do frontend passou 164/164. No runtime headless SS5, 21 métodos passaram por Verify/salvamento/recarga com zero mensagens, 1.523 verificações e plano repetido vazio. Na publicação **4958**, 67 casos foram executados por HTTP nas 21 actions originais, comparando valores e 12 exceções completas com um oráculo .NET 8.0.18; todos passaram, assim como a recusa de chave inválida. A prova é `.local/data-logic-translator/temporal-execution-v4958.json`. A regressão ampla de 480 continua identificada como versão 4957, sem ser reclassificada como execução da 4958. Codecs completos de fronteira/persistência, SQL temporal, double arbitrário e formatos culturais gerais continuam pendentes. O corpus frio de 36 casos de datas permanece separado e não foi declarado aprovado.

`DateTimeOffset` conserva ticks UTC e offset; `TimeSpan` conserva ticks assinados. A publicação **4959** passou **118/118 HTTP**: 117 casos nas 45 actions originais de `TemporalInstants.cs.txt`, com 36 exceções comparadas por tipo e mensagem, mais recusa da chave inválida. Construção, limites, deslocamentos, operações levantadas para anuláveis e cálculos exatos selecionados foram comparados com .NET 8.0.18. Frontend temporal: 231/231; prova nativa SS5: 45 actions, 8 estruturas, Verify/recarga sem mensagens, 2.734 verificações e plano repetido vazio. Evidência com 101 arquivos/hash em `.local/data-logic-translator/instant-execution-v4959.json`. As provas 480/480 e 68/68 permanecem vinculadas às versões 4957 e 4958; não são uma bateria única na 4959. Intermediários `DateTime` exatos não podem atravessar silenciosamente o armazenamento legado de `Date Time`. Referências mutáveis e conclusão excepcional entre helpers estão na etapa seguinte, ainda sem alegação de execução nativa.

Ainda faltam consultas mais completas (incluindo outer joins, grupos materializados como listas e mais overloads), ativação padrão do transporte de referências, operações completas de listas/records, datas/texto com semântica completa, adaptação de falhas opacas/transações, chamadas assíncronas, aquisição de referências externas e evolução validada contra dados persistidos. O primeiro teste frio revelou os problemas de texto e nulidade já corrigidos; uma nova avaliação fria de entrega completa ainda está pendente.

```csharp
public static Sample? Find(IDataSession database, Id<Sample> id)
    => database.Query<Sample>().SingleOrDefault(sample => sample.Id == id);
```

`Query` lê valores destacados do armazenamento: mudar um objeto lido não grava dados implicitamente. `Insert` retorna a identidade gerada sem modificar o objeto recebido. `Update` exige uma identidade existente; constraints e validações continuam no caminho da escrita. Em testes C# comuns, essa interface pode receber um armazenamento em memória ou um double do projeto.

## Nós nativos com autoria C# ainda pendente

O mapa do motor declarativo não é o mapa do frontend C#. `docs/mapa/action-coverage.md` registra
Verify/recarga/merge para os nós abaixo; essas provas de modelo não substituem a execução de entradas high code.

| Recurso | Motor declarativo | Entrada natural C# |
|---|---|---|
| JSON Serialize / Deserialize | Nós nativos provados; JSON também é usado nos bindings internos de UI | `System.Text.Json.JsonSerializer.Serialize/Deserialize` ainda sem tradução de autoria |
| Excel To Record List / Record List To Excel | Nós nativos provados em actions de servidor | API tipada de leitura/escrita de planilhas ainda pendente |
| Comentários flutuantes | `ICommentNode` criado como anotação fora do fluxo | Comentários `//` e `/* */` ainda não são convertidos em anotações do grafo |

Esses itens integram a cobertura restante de Logic. A implementação deve preservar nomes de campos,
nulidade, formatos, tipos e erros; criar o nó correspondente sozinho não prova equivalência à API C#.

## Entrada

No controlador, a fonte inteira entra em `propose.csharpSource`, como texto ou `{ "files": { "Domain.cs": "...", "Rules.cs": "..." } }`. Esse objeto transporta arquivos; não descreve nós ou operações. Todos os arquivos são analisados juntos e congelados para a entrega.

Na manutenção autorizada, o mesmo caminho aceita `anvil deliver --module Modulo --spec Source.cs`. A extensão `.cs` seleciona o frontend; não é necessário gerar um job manualmente. A instalação da faixa precisa conter essa versão antes de usar a nova entrada. Publicação de produto continua humana; provas de laboratório seguem a autorização específica do dono.

O SDK `Anvil.Authoring` não depende de DLLs OutSystems. Testes C# normais podem compilar e executar a fonte. O compilador de produto somente analisa a fonte e emite o contrato nativo; não emite/carrega um assembly autorado para executar negócio durante a tradução.

# ADR-020 — Referências mutáveis e exceções lexicais em fluxo nativo

2026-09-07. Decisão de representação para implementação; suporte e provas ainda pendentes.
Complementa [ADR-018](ADR-018-csharp-semantic-frontend.md) e
[ADR-019](ADR-019-typed-framework-primitives.md), seguindo o [manifesto](../../MANIFESTO.md).

## Problema observado

`SourceValue` representa texto/tipo/presença, sem identidade de objeto. `DataModel` transporta classes
e coleções como estruturas/listas nativas; `MethodExpressions.Target` recusa corretamente sua mutação
para evitar cópias silenciosas. Chamadas devolvem apenas o resultado declarado. `Statement` não trata
`ITryOperation`; `Throw` aceita somente construção, descarta `paramName` e não representa rethrow ou
inner exception. Os handlers de `LogicExpander` pertencem à action inteira, sem escopo léxico ou filtro.

O corpus independente `.local/data-logic-translator/cold-exception-authoring/` fixa 46 casos, com
26 retornos e 20 exceções, incluindo o estado final do journal e o trace completo. Exemplos decisivos:

- `invoice-null-specific`: filtro do chamador antes do `finally` do helper.
- `invoice-ledger-overrides-exception`: filtro original, limpeza que lança, novo filtro para a substituta.
- `close-catch-throws-past-sibling`: catch lança para a busca externa, sem visitar catches irmãos.
- `batch-return-snapshot`: retorno 17, journal final 127.
- `close-wrapper-rethrow-chain`: rethrow preserva tipo, mensagem com parâmetro e inner exception.

Adicionar `List.Add` isoladamente ou um handler por action não resolve esse contrato.

## Decisão

Adicionar ao frontend uma representação de referências/locais de escrita e uma IR de regiões léxicas
com continuações tipadas. Ambas são internas e geradas pelo compilador. O autor continua escrevendo C#;
não fornece handles, contextos, wrappers, jobs nem bindings adicionais.

O negócio continua em atribuições, condições, laços, consultas e chamadas nativas editáveis. Reusar o
contrato e a entrega existentes; não criar um executor operacional por linguagem. Blocos extraídos de
catch/filtro/finally e seu roteamento devem manter mapeamento para a fonte e layout revisável. Um eventual
dispatcher finito gerado só escolhe continuações já compiladas: não recebe AST, opcodes de negócio,
expressões serializadas, nomes arbitrários de métodos, fonte ou assembly para executar. Primitivas de
framework continuam sujeitas à fronteira estreita do ADR-019; nenhuma dependência nova é decidida aqui.

### Valores, referências e `Place`

Separar tipo de execução do formato de transporte/persistência em `DataModel`. Objetos de referência
e coleções usam handles tipados para células em arenas locais à invocação, materializadas em estruturas
e listas nativas. Por exemplo, `JournalCell` contém `Total` e `EntriesRef`; a célula dessa lista contém
seus itens. A arena não cria tabelas persistidas. Identidade de alocação não é a chave de uma entidade.

`Place` identifica local, parâmetro, campo de objeto ou elemento de coleção. `Load`/`Store` capturam
receiver e índice uma vez, aplicam os checks na ordem da fonte e fazem writeback explícito da célula.
Não depender de aliasing incidental de listas nativas aninhadas. `Snapshot` de referência copia o
handle; valores struct são copiados. Um `with` de record class aloca o objeto externo e preserva as
referências dos membros não substituídos. Null de referência não depende da anotação nullable; valores
`Nullable<T>` conservam presença explícita.

Alocação executa inicializadores da fonte uma vez por instância, inclusive `Entries = new()`.
Inicialização/defaults de DTOs e hidratação da entrada devem ter contrato próprio; não preencher valores
segundo o esperado de um teste. Tipos/recursos não representados continuam produzindo diagnóstico.

### Contexto e conclusão entre métodos

A ABI interna transporta `ContextIn -> ContextOut + Completion`, com resultados e locais capturados
em campos tipados por método/região. O contexto contém as arenas e os frames necessários; não é um
dicionário de objetos. Chamadas que podem mutar ou participar de uma transferência excepcional usam
essa ABI, incluindo filtros e helpers. Estado é devolvido também quando há exceção ou suspensão.
Uma análise de efeitos compartilhada pode manter o caminho direto para métodos que não precisam dela.

`Completion` distingue continuação normal, retorno, break, continue e throw. Destinos são identidades
geradas de controle; o valor de retorno fica em slot tipado, capturado antes da limpeza. Frames preservam
locais, exceção do catch ativo, região/origem da busca, handler escolhido e posição de unwind/retomada.
Um payload de exceção mantém identidade, tipo dinâmico, mensagem, parâmetro e referência para a inner
exception; compatibilidade de catches deriva dos símbolos/tipos, não da igualdade de nomes nativos.

### Busca antes de unwind

1. Ao lançar, buscar catches elegíveis de dentro para fora, atravessando os frames preservados.
   Avaliar tipos e filtros na ordem da fonte, com o contexto atualizado. Ainda não executar os finalizers
   que serão atravessados até o handler escolhido.
2. Filtro falso continua a busca. Exceção que escapa do filtro rejeita esse filtro, preservando seus
   efeitos e retomando a busca da exceção original. Uma barreira de filtro separa esse resultado da
   propagação normal; regiões protegidas dentro de filtros precisam de testes específicos adicionais.
3. Escolhido um handler, executar os finalizers intermediários, do interior para o exterior, e então
   entrar no catch. O finally associado a esse catch só ocorre quando ele sai. Sem handler, concluir
   o unwind até a fronteira de propagação.
4. Throw durante finally abandona a conclusão e a seleção anteriores. Reiniciar a busca na posição
   léxica desse throw, sem reexecutar o finally já iniciado. Não basta guardar uma lista de limpezas:
   a substituta pode ser tratada em um escopo suspenso e retomar execução dentro do callee.
5. `throw;` conserva a referência da exceção ativa e busca fora do grupo de catches corrente. Throw
   novo em catch também ignora seus irmãos. Fallthrough de catch retoma a continuação léxica correta.
6. Retorno/break/continue atravessam os finalizers dos escopos que deixam. Continue chega ao incremento
   do laço depois da limpeza; break o ignora. Throw na limpeza pode substituir qualquer transferência.

Guards gerados, como overflow e acesso inválido, devem entrar no mesmo mecanismo de throw. Handlers
nativos podem normalizar falhas de uma primitiva isolada, com estado preservado; não substituem a busca
léxica C#. Formatação de mensagens, concatenação escalar e `exception.GetType().Name` são semânticas
compartilhadas do frontend/framework, sem regras por nome de caso.

## Pontos de implementação e invariantes

| Área | Responsabilidade |
| --- | --- |
| `DataModel`, módulo de referências | Tipos de execução versus transporte; arenas, frames, alocação e `Place`. |
| `MethodValues`, `MethodCollections` | Cópia/conversão por categoria; loads/stores e mutação da coleção referida. |
| `MethodExpressions` | Ordem de receiver/argumentos, chamadas com contexto/conclusão, construção e membros de exceção. |
| `MethodCompiler`, IR/emissor de regiões | Transferências, busca, unwind e retomada; guard e throw pelo mesmo caminho. |
| `LogicModel` | Assinaturas internas antes dos corpos, efeitos transitivos, auxiliares privados e source map. |

Invariantes de revisão/prova: aliases observam a mesma célula; uma alocação nova tem identidade distinta;
efeitos anteriores a throw e de filtros rejeitados sobrevivem; cada região de limpeza executa uma vez
por saída; retorno capturado não acompanha mutações posteriores; nenhum corpo continua após conclusão
pendente sem a retomada correspondente; rethrow não reconstrói a exceção; todo negócio permanece em nós
nativos. Não adicionar verbos ao núcleo antes de demonstrar a lacuna do contrato atual.

## Fronteiras ainda dependentes de prova

- DTOs planos não expressam aliasing arbitrário entre parâmetros. Definir importação/exportação de
  identidade na fronteira sem prometer que igualdade de conteúdo significa o mesmo objeto.
- Raise na action pública pode impedir o consumidor de receber outputs. Provar onde o contexto final
  e a exceção são observáveis. Uma entrada de observação gerada pode chamar a ABI interna e expor o
  resultado efetivo, mas não pode fabricar o trace nem certificar sozinha o comportamento do wrapper público.
- O Core passou a declarar assinaturas por componente antes dos corpos para permitir chamadas recursivas
  nativas; contrato e limites em [recursão de actions](../architecture/2026-09-08-native-action-recursion.md).
  Isso não prova o roteamento excepcional nem a terminação de programas arbitrários.
- O corpus fixa cultura invariável e .NET 10. Mensagens/construtores, falhas de plataforma, transações,
  exceções em filtros com regiões aninhadas, referências que escapam, async e demais recursos CLR exigem
  provas próprias. Não inferir suporte universal a partir destes 46 casos.
- Medir tamanho dos grafos, cópias do contexto e tempo; não trocar silenciosamente legibilidade ou
  semântica por desempenho. Representação de arenas/writeback ainda precisa de Verify, recarga e execução.

## Validação em fases, sem reduzir a aceitação

1. Provar `Place`, identidade, inicialização e contexto em chamadas normais/excepcionais com testes
   semânticos pequenos. Acrescentar casos independentes de aliasing; não editar o corpus frio existente.
2. Primeiro corte vertical: caminho de `ApproveInvoice` com journal compartilhado, filtro no chamador,
   helper suspenso, filtro que lança e exceção substituta na limpeza. Resultados parciais são diagnóstico,
   não uma nova definição de aceitação.
3. Usar a mesma representação em `PostBatch` (destinos e captura de retorno) e `ClosePeriod` (regiões,
   rethrow e inner exception). Compilar os oito métodos da fonte original e conservar seus três entry points.
4. Conferir tipos, nós, destinos, contratos e auxiliares após Verify/save/reload; executar no laboratório
   todos os 46 inputs contra as expectativas congeladas. Comparar retorno ou exceção completa, journal
   final e trace ordenado, guardando respostas brutas e prova separada da fronteira pública. Recusas,
   divergências e casos não executados permanecem abertos. Gates usuais de manutenção/entrega continuam.

Identidade congelada, conforme `MANIFEST.json` do corpus: fonte
`8e7069ec2081a7d71d3fbe6ddeb7dbb9fe8703469138e96da3a45b1404b0841d`; corpus
`cea94bd8edf736c4c2f31d421f174373f25a53836d4242a7f273d0d26a0a3359`
(SHA-256 dos bytes de `cases.json` seguidos dos de `expected.json`). Não regravar o oráculo para acomodar
a tradução. Este ADR registra investigação e direção de implementação; não registra testes ou entrega.

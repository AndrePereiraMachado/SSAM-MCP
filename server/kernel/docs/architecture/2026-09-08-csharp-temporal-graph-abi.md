# Valores temporais no grafo C# ABI4

ABI4 acrescenta codecs fechados para valores temporais ao transporte de referências C#. O autor usa os tipos BCL; representação, validação e bindings pertencem ao compilador e ao SDK. A versão está integrada e foi publicada no laboratório combinado 5043, com DateTime e DateTimeOffset exercitados por HTTP. A entrada de autoria ainda não foi ativada globalmente.

## Representação

O protocolo mantém `anvil.csharp.reference-graph`, a arena `Exceptions` e a conclusão pública com apenas `Kind` e `ExceptionRef`. A negociação usa entradas e saídas distintas: `AvGraphAbiIn` e `AvGraphAbiOut`, ambas com versão 4. O novo descritor é `{"kind":"temporal","type":{"kind":"temporal","name":"System.DateTime"}}`.

| Tipo BCL | Registro nativo | Domínio |
| --- | --- | --- |
| DateOnly | DayNumber: Integer | 0 a 3652058 |
| TimeOnly | Ticks: Long Integer | 0 a 863999999999 |
| TimeSpan | Ticks: Long Integer | Int64 assinado |
| DateTime | Ticks: Long Integer, Kind: Integer | Ticks válidos de DateTime; Kind de 0 a 2 |
| DateTimeOffset | UtcTicks: Long Integer, OffsetMinutes: Integer | Instantes UTC e civil válidos; offset inteiro entre -840 e 840 minutos |

Anuláveis usam a forma existente `nullable`; ausência exige `HasValue=false` e payload zerado. Números do transporte são inteiros JSON exatos. O SDK usa somente construtores e acessores públicos desses cinco tipos BCL; getters, construtores e código arbitrário da fonte não são codecs.

DateTime usa ticks e Kind na fronteira do grafo, inclusive dentro de estruturas anuláveis. Não há conversão silenciosa para armazenamento nativo `Date Time`. Acesso a Kind admite o enum BCL exato DateTimeKind. Descritores inline vazios não podem mascarar tipos temporais.

## Validação e identidade

As entradas são verificadas antes do corpo da action, inclusive campos e elementos de listas/arrays. A resposta inteira é validada antes de escrever nos objetos do chamador. Em conclusão excepcional, mutações válidas são reconciliadas antes de lançar a exceção preservada pelo transporte.

A captura das contagens originais de todas as arenas continua antes da chamada da fonte. Elementos novos que se tornam inalcançáveis não podem virar raízes pelo compartilhamento de armazenamento de listas do runtime nativo.

ABI2 e ABI3 mantêm descritores e negociações anteriores. Leitores com limite de versão 2 ou 3 recusam ABI4; não interpretam silenciosamente formas desconhecidas.

## Limite de DateTime.Local

Ticks e Kind não preservam o estado interno de ambiguidade de horário de verão de todo DateTime.Local. O SDK compara o ToBinary público do valor com sua reconstrução por ticks/Kind e recusa o caso não representável antes do envio. Não normaliza silenciosamente o instante. Um codec mais amplo e operações de timezone continuam como decisão separada; DateTimeOffset conserva offset explícito e ambos os instantes.

## Evidência e pendências

O patch congelado está em `.local/data-logic-translator/temporal-graph-codec-freeze`, com baseline, candidato e hashes. A integração preservou a correção de contagens originais e acrescentou a capacidade ABI4 ao NativeCSharpSourceCall.

- Frontend integrado: 974 aprovados, seis lacunas antigas ignoradas. TRX: `.local/data-logic-translator/temporal-codec-root-results/temporal-codec-root.trx`.
- Prova nativa: seis endpoints e seis helpers, 372 operações, 16.285 objetos, 18.663 asserções de contrato, Verify sem mensagens, recarga equivalente, merge sem conflitos e plano repetido vazio. Duração total do teste: 7m42s.
- Fonte original `tests/csharp/temporal-graph/TemporalSchedule.cs.txt` preservada; 234 arquivos de entrada de build sem alterações durante a prova. Evidência e hashes: `.local/data-logic-translator/native-temporal-graph/18d2bbe028c34dc89e4480dae4452439/evidence.json`.

Esse teste é de modelo e merge em fixture. A prova posterior `.local/data-logic-translator/boundary-composition-progress.json` registra 18/18 chamadas HTTP da fonte combinada em ZZBoundaryComposition_CS versão5043, incluindo DateTime/DateTimeOffset, seus defaults e offsets. Ela não executa os cinco tipos desse fixture. Execução publicada abrangente, ativação automática do fluxo público, persistência temporal e uso cego continuam pendentes. As provas temporais publicadas mais antigas têm seus próprios contratos e não comprovam ABI4.

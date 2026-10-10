# Fechamento da leitura de referências — 18/09/2026

Esta rodada fecha a implementação e a validação de leitura de usos e reapontamento em
ODC e O11. O leitor e os testes de referência são compartilhados. A latência das consultas
repetidas ainda está pendente; os critérios estão em `FRICCAO-LEITURA-QUOTES.md`.

## O que foi corrigido

- A consulta distingue referências ao elemento e aos seus filhos, como `IdentifierType`,
  atributos e parâmetros. Cada aresta identifica consumidor e alvo efetivamente referenciado.
- Chaves retornadas pela leitura podem selecionar tipos no reapontamento. Chaves com `/`
  são tratadas como identidades inteiras, e filhos materializados após o primeiro lookup são encontrados.
- `replace` verifica os consumidores no destino e referências residuais na origem. O runner
  compara os conjuntos finais após salvar e recarregar o candidato; divergência impede aceitação.
- Cortes, erros de leitura e consultas de tipo não observado são declarados na resposta.

Os limites do contrato e os comandos estão em `USOS-REFERENCIAS.md`. A prova não certifica
equivalência de comportamento, referências por texto/runtime, consumidores de outros módulos
ou qualquer refatoração arbitrária. A verificação de recarga é headless, não uma prova de merge vivo.

## Regressões encontradas no fechamento

O runtime instalado é .NET 10.0.12. O frontend C# usa os assemblies desse runtime para resolver
assinaturas, embora os projetos sejam compilados para net8 com roll-forward habilitado.

1. As fábricas de `TimeSpan` passaram a resolver argumentos inteiros para overloads inteiros.
   O compilador agora preserva a multiplicação exata e verifica limites antes dela, mantendo
   o tipo de exceção desses overloads. O caso original de `TemporalInstants`, com 45 métodos,
   voltou a passar na verificação nativa, save/reload e plano repetido vazio. O suporte a
   `double` continua com suas restrições explícitas.
2. O comportamento do construtor de exceção com mensagem `null` mudou entre runtimes.
   A tradução agora usa o comportamento da BCL vinculada, somente para os 14 tipos permitidos,
   sem executar código de autoria. Os testes comparam `null`, texto vazio e texto explícito
   contra a execução CLR, mantendo as verificações de identidade e efeitos anteriores ao throw.
3. Seis JSONs usados como resultados independentes tinham sido normalizados para LF pelo Git,
   contrariando seus hashes congelados. Foram restaurados aos bytes exatos esperados e excluídos
   da normalização. Os hashes esperados e o conteúdo JSON não foram alterados. Um arquivo possui
   finais de linha mistos; sua cópia original preservada foi usada como fonte dos bytes.

## Validação

| Camada | Resultado |
|---|---|
| Node: raiz, fachada, MCP e Portal | 106 aprovados, nenhum ignorado |
| Kernel ODC, suíte completa | 93 aprovados, nenhum ignorado |
| Kernel O11, suíte completa | 1.148 aprovados, nenhum ignorado; 39,55 minutos |
| Compilador C#, suíte completa final | 1.210 aprovados, seis ignorados preexistentes, nenhuma falha |
| Seis casos de capacidade pendente, ativados explicitamente | Seis falhas reproduzidas; capacidades continuam incompletas |
| ODC após a correção final de mensagens de exceção | 12 testes afetados aprovados |
| O11 após a correção final de mensagens de exceção | 19 testes afetados aprovados; 2,20 minutos |

Os seis testes ignorados são os casos opt-in de `ReferenceBoundaryCapabilityGapTests`, sobre
identidade, null, compartilhamento, ciclos e efeitos na fronteira pública do compilador C#.
Continuam sendo lacunas conhecidas; não foram removidos nem convertidos em testes aprovados.
Esses casos são distintos do índice de referências entre elementos da OML.

Após pergunta do usuário, os seis foram ativados em execução isolada com
`ANVIL_RUN_REFERENCE_BOUNDARY_GAPS=1` e o filtro `ReferenceBoundaryCapabilityGapTests`.
Resultado atual: seis falhas em 2,75 segundos, registradas em `closure-known-boundary-gaps.log`
e no TRX de mesmo nome. A suíte padrão verde não certifica essas capacidades:

| Caso | Resultado observado na prova |
|---|---|
| Receber/devolver o mesmo objeto | A identidade esperada não é preservada |
| Receber/devolver a mesma lista | A identidade esperada não é preservada |
| Dois membros compartilhando o mesmo objeto | O compartilhamento esperado não é preservado |
| Argumento de referência `null`, sem anotação `?` | O teste de ausência retorna falso em vez de verdadeiro |
| Objeto que aponta para si mesmo | O probe falha ao construir o registro nativo recursivo; ainda falta uma representação adequada nessa entrada |
| Mutação anterior a um throw visível ao chamador | A compilação pública recusa o caso com AVCS310, exigindo representação de presença/identidade |

São testes do frontend e do probe de lógica gerada; essa execução não publica nem executa
actions num servidor OutSystems. A marcação opt-in foi preservada e não faz esses casos contarem
como aprovados. Corrigi-los exige uma etapa própria no transporte público de objetos do tradutor.

A suíte nativa completa começou antes da última correção de mensagens de exceção. Por isso,
o compilador teve nova suíte completa e os testes nativos afetados são executados novamente
com a compilação final. Os resultados de cada execução permanecem separados.
As duas CLIs locais foram recompiladas em Release pelos scripts do kernel, sem iniciar
workers nem substituir DLLs carregadas nos Studios.

O corpus autorizado contém 33 originais; cinco cópias foram examinadas: 143.809 objetos,
116.375 arestas e nove FKs conferidas também pela propriedade `DataType`. Nenhum original
foi alterado. Isso é cobertura observada, não certificação de todo elemento possível do ODC.

Logs, TRX, hashes e resultados privados: `.local/usage-audit/20260918-c04c54b8/` e
`kernel/tests/*/TestResults/closure-*.trx`. As OMLs de usuário não entram no Git.
O checkpoint contém as alterações desta tarefa; trabalho concorrente no bridge/fachada e
nas features de Quotes foi preservado separadamente e não está certificado por estes resultados.

Para repetir, a partir da raiz, execute as suítes nativas sequencialmente por plataforma:

```powershell
$env:ANVIL_LANE = 'ss4'
dotnet test kernel/tests/Anvil.Tests
dotnet test kernel/tests/Anvil.Tests.Odc
dotnet test kernel/tests/Anvil.CSharp.Tests
npm test
```

## Próxima etapa

Medir e reduzir cargas repetidas da mesma captura, com invalidação por conteúdo, leitor e
runtime; selecionar várias actions por consulta; oferecer navegação de fluxo e saída útil
sem filtragem manual de JSON. Validar primeiro no ODC e reutilizar o mecanismo no O11.
Nenhuma meta em milissegundos foi declarada atingida nesta rodada.

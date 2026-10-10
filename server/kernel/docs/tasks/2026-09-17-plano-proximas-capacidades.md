# O que implementar a seguir, e por quê

Lista tirada da análise das DLLs decompiladas das duas plataformas (`2026-09-17-api-nativa-o11-odc.md` e
`2026-09-17-mentor-odc.md`), já corrigida duas vezes pelo dono. Ordem por valor sobre esforço. Cada item diz onde
mexe, o que prova que funcionou, e o que ele destrava.

## Bloco 1 — barato, não muda o desenho de nada

| # | O que | Onde | Prova |
|---|---|---|---|
| 1 | **Verify antes e depois de cada op de escrita**, devolvido no resultado da op (não só no fim do job) | `Kernel/Verbs.cs`, as duas faixas | um job que introduz aviso mostra em qual op ele nasceu |
| 2 | **Portão de equivalência pelo `OdcDiff`** no caminho da entrega, no lugar do gate escrito à mão | `Adapters.ODC/StudioSessionOdc.cs` | repetir a entrega do `block-alert`: o relatório de diferenças sai do diff nativo |
| 3 | **Endereço estável de objeto** (`GetTargetPath` / `ResolveTargetPath`) como forma de referência aceita nos jobs | `Adapters.ODC` + `Kernel/Verbs.cs` (resolução) | um job endereça um widget dentro de um container sem `#ITipo` |

O item 1 é o laço que o Mentor usa em toda ferramenta de escrita, e é o que mais aumenta acerto de LLM por linha de
código escrita.

## Bloco 2 — refatoração de verdade, o mesmo código nas duas faixas

| # | O que | Como | Prova |
|---|---|---|---|
| 4 | **Verbo `replace {de, para}`** | percorrer os consumidores e chamar `ReplaceReferences(A, B)` em cada um; publicado no ODC, cast de framework no O11 (é o mesmo método) | trocar uma action por outra e o `OdcDiff` mostrar só as referências mudadas |
| 5 | **Verbo `extract` (para ação e para bloco)** | `ExtractToActionCommand.Execute(seleção, IPresenter)` de `ServiceStudio.BuiltInBehaviors.dll`, com o `MockAggregatorPresenter` que o `Publisher.Mutate` já constrói; a análise de escopo e a geração de parâmetros vêm prontas | extrair três nós de uma action e o Verify continuar limpo, com as entradas e saídas geradas contadas |
| 6 | **Verbo `move` de verdade** (reparentar) | `IModelServices.MoveObject(origem, novoPai)`, público nas duas e sem uso no kernel. Atenção: devolve **objeto novo**, os handles do job precisam ser reapontados | mover um widget de um container para outro sem apagar e recriar |

Hoje o verbo `move` só muda posição e ordem; reparentar é apagar e recriar, que perde identidade e consumidores.

## Bloco 3 — qualidade de escrita

| # | O que | Onde |
|---|---|---|
| 7 | **Expressões tipadas no ODC**: perguntar à propriedade o que ela aceita (`IExpressionProperty.RuntimeTypeKind`, `SupportsTypeConversion`, `GetRequiredTypes`) antes de escrever, e usar os literais tipados da AST | `Kernel/Verbs.cs` no `Convert`, via adaptador |
| 8 | **Dependências**: `AddDependency` e `RemoveUnusedDependencies`, públicos no O11 e sem uso | `Kernel`, faixa O11 |

O item 7 mata na origem a classe de erro que custou uma rodada ontem (inteiro contra inteiro longo).

## Bloco 4 — decisão de rumo, não fazer sem o dono decidir

| # | O que | A tensão |
|---|---|---|
| 9 | **Op `csharp`**: aceitar código C# da Model API e executar por `CSharpCodeExtensions.ExecuteRestricted` (sandbox da própria plataforma, 30 s e 500 MB no uso do Mentor, validador, saída capturada) | tira o teto dos verbos fechados, mas reabre a porta do código livre que motivou a troca por nativo. Recomendação: só como saída de emergência, sempre no clone, nunca como caminho principal |
| 10 | **Entrega por clone e merge** como padrão: clonar o módulo, aplicar no clone, comparar e mesclar | dá revisão, desfazer e isolamento quase de graça; muda o fluxo de entrega que hoje já funciona |

## O que não levar

O protocolo de WebSocket com descoberta de ferramentas do Mentor. O nosso MCP já ocupa esse lugar; trocar traz custo
sem ganho.

## Regra que ficou desta análise

Duas vezes afirmei que a plataforma não tinha um recurso quando eu só não tinha procurado no lugar certo. O código de
refatoração não mora no `Presenter`: mora em `ServiceStudio.BuiltInBehaviors.dll` e no framework
(`ServiceStudio.Framework.dll` no O11, `OutSystems.Model.dll` no ODC). Antes de dizer que algo não existe, procurar
nos três, e nas duas codificações de string (as do Presenter do ODC são criptografadas).

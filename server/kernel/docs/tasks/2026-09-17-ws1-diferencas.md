# WS1: diferenças de API entre o SS11 e o ODC encontradas ao compilar e correr o kernel contra o ODC

Cada linha: a diferença, o erro colado como apareceu, e o que o kernel faz agora (edições mecânicas do integrador,
extensão do WS0, guardadas pela suíte SS11). Nenhuma foi contornada com `#if`: cada build resolve pelo seu
adaptador ou por um ramo neutro no kernel.

## Compilação (105 erros em 19 arquivos → 0)

| Diferença | Erro (exemplo) | O que o kernel faz |
|---|---|---|
| `IObjectSignature.Parent`/`Children` devolvem `IModelObject` no ODC (o SS11 não tem `IModelObject`) | `CS1503: não é possível converter de "OutSystems.Model.IModelObject" para "OutSystems.Model.IObjectSignature"` (36 pontos) | `.Children.OfType<IObjectSignature>()` e padrões `is IObjectSignature x` nos 36 pontos; no SS11 é um filtro nulo |
| `IExpression` vive em `OutSystems.Model.Expressions` no ODC, em `OutSystems.Model` no SS11 | `CS0246: O nome do tipo "IExpression" não pode ser encontrado` (25) | o kernel nomeia `IExpression` sem qualificar; o build ODC tem `global using IExpression = OutSystems.Model.Expressions.IExpression` (`Adapters.ODC/GlobalUsings.cs`) |
| Não há `OutSystems.Model.IParameter` no ODC (só `IInputParameter`/`IOutputParameter`) | `CS0234: "IParameter" não existe no namespace "OutSystems.Model"` | `ExpressionCheck.FindSource` reconhece parâmetros pelo nome da interface (`IParameter`, `IInputParameter`, `IOutputParameter`) |
| `EntityIndexes`, `NativePerformanceCapture`, `BridgeCallException` eram neutros mas viviam em arquivos SS11 | `CS0103: O nome "EntityIndexes" não existe` (29) | movidos para `Kernel/` |
| O descritor de funções built-in do ODC não tem `IsVisibleInServerQueries`/`IsVisibleInClientQueries` e expõe três visibilidades como `Func<ESpace,bool>` | `CS1061 ... não contém uma definição para "IsVisibleInServerQueries"` | `FunctionCatalog.Visibility` é método parcial: `Adapters.SS11/FunctionCatalogSs11.cs` e `Adapters.ODC/FunctionCatalogOdc.cs` |
| O catálogo Verify (`ServiceStudio.Verify.VerifyMessageId` + recursos) está em `OutSystems.Model.dll` no ODC, em `ServiceStudio.Framework.dll` no SS11 | (descoberta por inspeção da instalação) | leitor comum `Kernel/VerifyResources.cs`; cada adaptador passa o seu assembly |

## Execução (os três jobs de `tests/jobs-odc`)

| Diferença | Erro colado | O que o kernel faz |
|---|---|---|
| O mesmo nome de interface existe em mais de um namespace do ODC: `IStaticEntity`/`IEntity`/`IStructure` também em `OutSystems.Model.Extensions` e `ExternalLibraries`; `IStartNode`/`IEndNode`/`ICommentNode` também em `Processes` e `BusinessProcesses` | `spec op #0 (create WfProofStatus on @espace): ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Extensions.IStaticEntity`; `op #23 (create ): Nodes of type IEndNode are not allowed in IMobileScreen or eSpaces of type CrossDevice` | `FindCreateCore.Rank` despromove esses namespaces; `Create` passa ao candidato seguinte quando a fábrica recusa com essas mensagens (a exceção vem aninhada em dois `TargetInvocationException`: usa `GetBaseException()`) |
| O widget de expressão é `ServiceStudio.Plugin.NRWidgets.IExpression`, num assembly do diretório da instalação (`OutSystems.Model.Plugin.NRWidgets.dll`), não numa pasta `Plugins\` | `op #2 (create ): InvalidCastException: Unable to cast object of type 'WebBlockInstance' to type 'IParent`1[AbstractTopLevelWidget]'` (o kernel criava o objeto de expressão, não o widget) | `StudioAssembliesOdc.Bind` carrega o plugin; `ModelApiMetadata.Types` passa a vê-lo (rank 1, antes de `OutSystems.Model.Expressions.IExpression`) |
| `IPlaceholderContentWidget` do ODC tem `CreateWidget(Type, ...)` além do genérico | (o mesmo erro acima, na forma genérica) | `FindCreateCore` lista a forma `Type` antes da genérica e `Create` passa o candidato como argumento `Type` |
| Propriedades de expressão graváveis (valor de registo estático, default de atributo, `SetVariable` de input) recebem `OutSystems.Model.Expressions.ExpressionDefinition` (AST), não texto | `spec op #18 (set Value on $WfProofStatus.Active/Label): InvalidCastException: Invalid cast from 'System.String' to 'OutSystems.Model.Expressions.ExpressionDefinition'` | `Convert` chama `ExpressionDefinition.Parse(texto)` por reflexão; o contrato de dados lembra o texto (`Remembered`) porque a prova lê texto de volta (`Data property mismatch ... expected ExpressionDefinition+Text, actual "Active"`) |
| A legenda de um botão/link/label do ODC nasce dentro de `Content` (`IContent` → `ITextWidget`), no SS11 ao lado | `op #15 (set Text): KeyNotFoundException: IButton 'GreetButton' has no child #1 of type ITextWidget (has 0)` | o seletor `#ITipo` procura também dentro dos filhos `IContent` quando não há filho direto |
| Aggregates (e outras partes do modelo) perguntam ao `FeaturesProvider` do Studio | `logic op #5 (create GetActive ...): InvalidOperationException: Provider not initialized.` | `OdcFeatures.Initialize` (adaptador): cache local `%LocalAppData%\OutSystems\ODC Studio\Features.xml` + serviço de encriptação do Studio, como o builder do SSAM-Hybrid-ODC |
| Verify do ODC: `Count` de aggregate é `Long Integer`; server action sem consumidor recebe `UnusedUserAction` | `ExpressionUnexpectedExpresssionType ... 'Integer' data type expected instead of 'Long Integer'`; `UnusedUserAction ... is never used` | diferença de plataforma, não de kernel: o job declara o tipo certo e a mensagem esperada com `why` |

## Vista no T7 do WS4 (jobs html-visual sobre a fixture ODC), sem edição de kernel

| Diferença | Como aparece | O que acontece |
|---|---|---|
| ~~O tema do ODC separa o CSS gerado pelo Theme Editor (`StyleSheet`) do CSS do autor (`UserStyleSheet`)~~ **Não é diferença de plataforma** | o `get IMobileTheme:WrightFlood` mostra o bloco `/* anvil:html wf-alert */` em `UserStyleSheet`, não em `StyleSheet` | ver a secção "CSS do tema" abaixo: a separação existe nas duas plataformas e depende de o tema ter CSS do Theme Editor, não da plataforma. A fixture do ODC tem, a do O11 não — foi isso que se viu, e a conclusão de então estava errada |

## CSS do tema: três metades, e a leitura não é a escrita (vale nas duas plataformas)

`ServiceStudio.Model.WebStyleSheet` é idêntico no O11 e no ODC e guarda o CSS em três lugares:

| Metade | O que é | Como se lê hoje |
|---|---|---|
| `GeneratedCssSource` | o que o Theme Editor gera | `get` do tema → `GeneratedStyleSheet` |
| `UserCssSource` | o CSS do autor — o que a interface do Studio mostra e deixa editar (`PropertyIsUserVisible`) | `get` do tema → `UserStyleSheet` |
| `CssSource` | **derivada**: `gerada + "\r\n" + autor` (`WebStyleSheet.CalculateFinalCssSource`) | `get` do tema → `StyleSheet` |

O Model API publica só a derivada, e de forma assimétrica: `ITheme.StyleSheet` **lê** `CssSource` e **escreve** por
`SetCorrectCssSource`, que quando há CSS gerado grava `UserCssSource`. Quem recalcula a derivada é o refresh de cache
do Studio; sem interface ninguém o chamava. Medido na fixture do tenant pessoal (sonda do INT, 2026-09-17):

```
antes  StyleSheet 45320 chars = GeneratedStyleSheet 884 + CRLF + UserStyleSheet 44434
set StyleSheet "<53 chars>"   -> {"set":"StyleSheet","via":"property"}          (sucesso, sem nota)
depois UserStyleSheet 53 chars   <- os 44 434 caracteres de CSS do autor foram substituidos
       StyleSheet 45320 chars    <- INALTERADA: a leitura mostrava o texto antigo
```

Ou seja: a escrita era destrutiva e invisível na leitura — a frente R viu a metade de cima ("aceito e descartado") e
tinha razão no sintoma. O kernel passou a repor a derivada depois de escrever (a mesma conta da plataforma), o `get`
mostra as três metades quando divergem, e o `set` diz onde o texto caiu. O op `html` deixou de percorrer a derivada:
lê e escreve a metade do autor, senão um recorte que falhe duplica o bloco gerado dentro do CSS do autor. Provas:
`tests/jobs-odc/theme-css-halves.json` e `Anvil.Tests.Odc.ThemeCssTests`.

## Vista na prova viva do WS2 (merge nativo recusado pelo gate de equivalência), corrigida no kernel pelo INT

| Diferença | Como apareceu | O que o kernel faz |
|---|---|---|
| `IObject` do ODC tem `CreateSibling<T>` e `CreateSibling(Type)` (o SS11 não); `FindCreate` aceitava qualquer `Create*` cujo retorno servisse, e num `IContainer` escolhia `CreateSibling`: o widget nascia como irmão do container, em ordem inversa, fora do `Content` | gate de equivalência do merge: `WF_PinNotFoundBanner` `ChangedInLocal` por `EffectiveMarginLeft` em três widgets (lab\ws2-prova-viva 01/02); `screen-basic` do WS1 tinha a mesma hierarquia sem o teste notar | `FindCreateCore` ignora `CreateSibling*`; `IContainer.CreateWidget` do ODC delega ao `Content` e a ordem fica a do job (sonda: `Box → content → [one, Inner, two]`) |

## Vocabulário: o mesmo artefato com nomes diferentes

A API pública do ODC manteve nomes antigos que o **produto** já não usa. Quem escreve job vê um nome; quem abre o
ODC Studio vê outro. Registrado à medida que aparece:

| Na API (o que o job escreve) | No produto ODC (o que a interface mostra) | Evidência |
|---|---|---|
| `ISiteProperty`, `IESpace.CreateSiteProperty(...)`, `[ModelInterface(DisplayName = "Site Property")]` | **Settings** | marca de modelo `ModelFeature_SitePropertiesRefactoredToSettings` na `OutSystems.Model.dll` do ODC Studio. Ao lado dela, `ModelFeature_SitePropertiesSupportsSecretsO11` e `ModelFeature_WriteableSiteProperties_Removed`: além do nome, o comportamento mudou (gravável em runtime saiu, segredos entraram) |
| `Public` (propriedade) | **shareable** | a mensagem de erro do Verify usa a palavra: `InvalidPublic_ActionParameterNotPublic: ... is shareable but its parameter ... is not shareable`. E é **erro**, não aviso, ao contrário do O11 |

Regra prática: no job use o nome da API, porque é o que compila; no `description` do job e na documentação use o nome
do produto, senão uma sessão fria procura na interface por um nome que não existe.

## Processo (BPT) não existe no ODC

A API do ODC tem `CreateBusinessProcess` e o namespace `OutSystems.Model.BusinessProcesses.Nodes`, mas o **produto
não tem a funcionalidade** (confirmado pelo dono em 2026-09-17). Superfície de API não é prova de funcionalidade:
antes de escrever job para um tipo que só se viu na API, confirme que o produto o oferece.

## Duplicar e reordenar: nenhuma diferença, e a superfície extra do ODC não é usada

O `IObject` do ODC tem métodos de mover **no próprio objeto** (`MoveToEnd`, `MoveBefore`, `MoveAfter`,
`MoveAfterSibling`, `MoveBeforeSibling`, `MoveToNewAbsoluteIndex`, `MoveToNewRelativeIndex`) que o do O11 não tem; o
kernel não usa nenhum deles, usa os da **sequência** (`ISequence.MoveToStart/MoveToEnd/MoveBeforeSibling/MoveAfterSibling`),
que existem nas duas plataformas. Resultado medido lado a lado (`tests/jobs/refactor-move.json` e
`tests/jobs-odc/refactor-move.json`): a `order` devolvida por cada op é **idêntica**, nas quatro direções, sobre
atributos, widgets, parâmetros de entrada e variáveis de tela, mais o `x`/`y` de um nó. O `duplicate` idem
(`Body` → `Body2`, cópia no fim do mesmo pai, sem consumidores, entidade copiada com as suas próprias entity
actions). Registrado para que uma sessão fria não vá "adaptar" o verbo à API extra do ODC sem necessidade.

## Não é diferença, mas conta

- `ESpaceType` do WrightFlood é `CrossDevice` (`IsReactiveEspace = True`): o contexto `mobile` dos verbos de tela serve.
- Os layouts (`LayoutTopMenu`, `LayoutBase`, ...) são blocos do próprio módulo no ODC, não do produtor OutSystems UI.
- Carga da fixture: 59 281 objetos em ~1,6 s; um job de tela aplica em ~2 s.

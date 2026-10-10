# Ler, editar, refatorar e criar nas duas plataformas: o que a API nativa dá e o que só a GUI tem

Análise das DLLs decompiladas das duas instalações, em 2026-09-17. Decompilei para
`C:\Users\andre\ODC3\decompiled\` (fora de qualquer repositório): o ODC de
`C:\Program Files\OutSystems\ODC Studio\ODC Studio` (modelo com 2 073 arquivos, API pública com 1 254) e o O11 de
`C:\Users\andre\OutSystems\Service Studio 11 - Anvil 4516\Service Studio` (framework com 1 749 arquivos, API pública
com 435), que é a instalação contra a qual o kernel roda.

A conclusão curta: **a API pública do ODC é uma plataforma de refatoração; a do O11 é um construtor.** Onde o O11
obriga a descer ao framework interno ou a imitar a GUI, o ODC publica a operação.

---

## 1. O que descobri e já virou código

**Comparação de três vias headless na faixa ODC.** O ODC expõe `IModelServices.Diff(local, foreign, base)` →
`IMatchTree`, com `MatchType`, `DifferenceType` e um `MergeAction` **gravável** por objeto **e por propriedade**, mais
`Dump()` e `Merge()`. O O11 só tem `bool Merge(meu, outro, base)`: sem árvore, sem detalhe, sem controle — e é por
isso que o kernel carrega o seu próprio `MergeProbe`, excluído do build ODC.

Implementei como `OdcDiff.Compare` (`src/Anvil.Core.Odc/Adapters.ODC/OdcDiff.cs`), que só **lê**, e provei com
`TheOdcApiDiffsTwoModelsHeadlessAndSeesTheChangeOfAJob`:

| Medida | Valor |
|---|---|
| Comparações na fixture WrightFlood | 59 419 |
| Objetos só no candidato | 138 |
| Conflitos | 0 |
| Detalhe | valor local e estrangeiro de cada propriedade que difere |

É o portão de equivalência que o WS2 teve de montar à mão quando o merge foi recusado por `EffectiveMarginLeft`.

---

## 2. Ler

| Capacidade | ODC | O11 |
|---|---|---|
| Árvore e tipos | `IModelObject` (raiz), `Children`, `Parent`, `GetInterface()`, `GetAllDescendantsOfType<T>()` | `IObjectSignature` é a raiz; mesmos navegadores |
| **Quem usa este objeto** | `IModelObject.Referrers` — **público** | **não existe na API**; só `AbstractObject.Referers` do framework (é o que o kernel já usa por cast) |
| Identidade legível | `ReadableIdentifier`, `DisplayName`, `Descriptor`, `CollectionDescriptor` | só `ObjectKey`/`GlobalKey` |
| **Endereço textual estável** | `GetTargetPath()` / `ResolveTargetPath(root, path)` → `Entities\Order\Attributes\Id`, com `Tipo[n]` para anônimos | não existe |
| Metamodelo reflexivo | namespace `MetaModel` inteiro: `IProperty` com `GetValue`/`SetValue`/`IsReadOnly`/`GetDefaultValue`, `IChildCollection`, `ClassDescriptor.AllDescriptors` | `IProperty` é **interface vazia**; o equivalente (`PropertyDescriptor`) está no framework |
| Autoria por objeto | `CreatedByTool`, `CreatedByAgent`, `LastModifiedByTool`, `ModifiedByAgents` | não existe |
| Validação | `GetValidationMessages(...)` com `Id`, `Type`, `Detail`, `Owner`, `Hidden` gravável | igual |

## 3. Criar

As duas plataformas criam por `Create*` no container, e o inventário é grande dos dois lados: entidade, atributo,
structure, ação, nó de fluxo, tela, bloco, widget, agregado, SQL, integração, papel, exceção, tema, imagem, recurso.
Diferenças que importam:

- **Índice de entidade**: o ODC tem `IServerEntity.CreateIndex(name)`; o **O11 não tem** — o kernel instancia
  `new EntityIndex(...)` do framework, e essa é a única criação fora de `Create*`, fora dos ganchos do modelo.
- **Conectores de IA**, só no ODC: `CreateAgent`, `CreateMCPConnection`, `CreateA2AConnection`, `CreateKnowledgeBase`,
  `CreateAIModelConnection`, `CreateSearchServiceConnection`. Nada disso tem paralelo no O11.
- **Criação em lote declarativa**, só no ODC: `CreateOrTransformObjects(resolver, specs)` com `ModelObjectDefinition`,
  que **nomeia a coleção de destino explicitamente**. Isso dissolve na origem o problema de nomes ambíguos que o
  kernel resolve hoje por ranking de namespace.
- **`CreateSibling`**, só no ODC, cria **ao lado** e não dentro: foi a causa do bug que corrigi ontem. A própria API
  o exclui da descoberta reflexiva de fábricas, o que confirma que o nosso filtro está certo.

## 4. Editar

| Tema | ODC | O11 |
|---|---|---|
| Propriedade simples | setter, ou `IProperty.SetValue(obj, valor)` reflexivo | setter |
| Expressão | `Set<Prop>(ExpressionDefinition)`, com **AST tipada** (`Parse`, literais por tipo, validação na construção, `Diff` estrutural) | `Set<Prop>(string)`: texto, e o erro só aparece no Verify |
| Saber o que a propriedade aceita | `IExpressionProperty.SupportsTypeConversion`, `SupportsRecordAndListLiterals`, `RuntimeTypeKind`, `GetRequiredTypes(obj)` | não existe |
| Reescrever expressão nó a nó | `IMutableExpression` com 26 fábricas, preservando espaços em branco; `IExpression.Root` com bindings ligados ao objeto | só `IExpression.Text` |
| Substituir usos numa expressão | `SubstituteAndSimplify(mapa)` | existe também, e o kernel **não usa** |
| Trocar função embutida | `ITextBasedExpression.ReplaceBuiltinFunction(velha, nova)` | não existe |

O ponto prático: no ODC dá para **perguntar** que tipo de literal a propriedade quer, em vez de tentar e apanhar
exceção. Era o que resolveria na origem o caso `Integer` contra `Long Integer` que custou uma rodada ontem.

## 5. Refatorar

| Operação | ODC | O11 |
|---|---|---|
| Mover objeto para outro pai | `IObject.MoveTo*` + `IModelServices.MoveObject` | `IModelServices.MoveObject` (existe, e o kernel **não usa**; devolve objeto novo) |
| Reordenar coleção inteira | `ISequence.SetOrderTo` | igual, e o kernel não usa |
| **Repontar consumidores de A para B** | `IObjectSignature.ReplaceReferences(anterior, novo)`, publicado | **o mesmo método existe**, no framework, não publicado (ver abaixo) |
| Mover código entre módulos | `IESpace.Merge(objetos, opções, pareamentos)`, `Serialize`/`DeserializeInto` | as mesmas três existem |
| Envolver em container | `EncloseIn<T>(widgets)` + validação de contiguidade | não encontrado |
| Trocar produtor | `RefreshDependencies`, `AddDependency`, `RemoveUnusedDependencies` | as mesmas; a troca preservando usos é só da GUI, e **destrói o histórico de desfazer** |
| Renomear propagando | não existe comando nas duas: o modelo guarda **chaves**, e o texto se regenera. Literais, descrições, URLs e CSS não acompanham | igual |
| **Extrair para ação / para bloco** | **existe nas duas** (ver abaixo) | **existe nas duas** |
| Mudar assinatura com atualização de chamadores | não encontrei | não encontrei |

### Correção de 2026-09-17: extrair para ação existe, sim

A primeira versão deste documento dizia que extrair para ação não existia. **Estava errado**, e quem corrigiu foi o
dono. O erro foi de método: procurei classes com nome de refatoração dentro do `ServiceStudio.Presenter`, e o código
não mora lá. Mora em `ServiceStudio.BuiltInBehaviors.dll`, presente nas **duas** instalações:

```
ServiceStudio.Commands.FlowEditor.ExtractToAction          // classe pública, faz o trabalho
    ctor(AbstractNode raiz, IEnumerable<AbstractNode> folhas, IEnumerable<AbstractObject> seleção, IPresenter)
    CommandResult Execute(out int entradasGeradas, out int saídasGeradas)

ServiceStudio.Commands.FlowEditor.ExtractToActionCommand   // fachada, também pública
    static CommandResult Execute(IEnumerable<AbstractObject> seleção, IPresenter alvo)
    static bool AppliesToFlow(AbstractFlow) / AppliesToNodes(IEnumerable<AbstractObject>)
    static IEnumerable<AbstractObject> FilterEdgeNodes(IEnumerable<AbstractObject>)
```

E não é um atalho de interface: a classe cria a ação nova, cria o nó que a chama, cria o assign de saída, e **calcula
sozinha os parâmetros de entrada e saída** analisando as expressões e o escopo dos nós selecionados
(`CalculateCandidateInputObjects`, `CreateNeededInputsParameters`, `CreateNeededOutputParameters`, com um visitor
próprio para expressões de aggregate). O `Execute` ainda devolve quantas entradas e saídas gerou.

Existe também extrair para bloco, nas duas: `ExtractToBlockSingleNode` e `ExtractToBlockMultipleWidgets`
(no `ServiceStudio.Presenter` do O11, no `ServiceStudio.Framework` do ODC), mais `ExtractToServerAction` no O11.

**Isso é alcançável sem interface gráfica com o que já temos.** O único requisito é um `IPresenter`, e o adaptador
SS11 já constrói um: `Publisher.Mutate` usa `MockAggregatorPresenter` + `MockPresenter` +
`Command.Execute(presenter.GetPresenterContext(), ...)`. Ou seja, a refatoração mais valiosa das duas plataformas
está a uma chamada de distância, dentro da transação que já usamos.

Mesma lição para o "substituir usos": no O11 `ReplaceCommands.Replace` recebe o objeto de origem **e o objeto de
substituição**, não só texto, e vem com `GetReplaceWarnings`, que confere compatibilidade de atributos e parâmetros
por nome e tipo antes de trocar. É refatoração de verdade, também no `Presenter`, também alcançável com o mesmo
presenter headless.

### Correção: repontar consumidores não precisa ser imitado no O11 — é o mesmo método

Eu disse que no O11 não havia equivalente do `ReplaceReferences`. **Errado de novo, e pelo mesmo motivo**: olhei só a
API publicada. O método é do framework, e existe nas duas:

```
O11   ServiceStudio.Model.AbstractObject:4612
          public virtual void ReplaceReferences(AbstractObject anterior, AbstractObject novo)
      ServiceStudio.Model.Interfaces.IReferer:20          // interface pública
          IEnumerable<AbstractObject> ReferedObjects { get; }
          void ReplaceReferences(AbstractObject anterior, AbstractObject novo);

ODC   AbstractObject:2047
          void IObjectSignature.ReplaceReferences(IObjectSignature anterior, IObjectSignature novo)
              => ReplaceReferences(anterior as AbstractObject, novo as AbstractObject);
```

Ou seja: **o método publicado do ODC é uma casca de uma linha sobre o mesmo método de framework que o O11 também
tem.** Quem sobrescreve, nas duas: expressões (`ParsedExpression`, com religação automática), expressões
JavaScript, temas, fluxos de referência, literais de registro.

Duas precisões que a minha descrição anterior errava:

1. O método é chamado **no consumidor**, não no alvo. O padrão real, visto no `ObjectCloner` e no caminho de apagar
   das duas plataformas, é percorrer os referers e chamar `referer.ReplaceReferences(A, B)` em cada um; `B` nulo
   significa desligar a referência.
2. Existe também `ReplaceReferencesForFindAndReplace`, que é a variante usada pelo Find and Replace e trata nome do
   pai e religação de forma um pouco diferente.

Portanto um verbo `replace {de, para}` é o **mesmo código nas duas faixas**: pegar os consumidores (que o kernel já
sabe obter por `Referers`) e chamar o método em cada um, dentro da transação que já usamos, com o Verify no fim. No
ODC dá para usar a via publicada; no O11, o mesmo cast para framework que o kernel já faz para ler consumidores e
para criar índices de entidade. É superfície de framework, e portanto pode mudar entre versões do Studio: o risco é
conhecido, já existe em três pontos do kernel, e a suíte pega a quebra.

## 6. Em massa e transação

- **Em massa**: nenhuma das duas tem visitor público. O laço é de quem chama, sobre `GetAllDescendantsOfType<T>()`.
  O que existe de verdadeiramente em lote: no ODC, `CreateOrTransformObjects` e `ApplyToTextResources`; nas duas,
  `Merge` de N objetos, `Serialize`/`DeserializeInto`, `SetOrderTo`, `SubstituteAndSimplify`.
- **Transação**: no ODC é `ITransactionsManager.ExecuteTransaction` (o que o adaptador já usa), com `Undo`, `Redo`,
  `CanUndo`, agrupamento por `transactionGroupId`, e eventos `TransactionCompleted` que entregam a lista exata de
  objetos tocados. Três avisos reais: as formas assíncrona, oculta e descartável lançam `NotImplementedException`
  nessa estratégia; num eSpace não registrado a transação **roda sem transação**; e o rollback é o `UndoManager` do
  Studio. No O11 **não existe `ITransactionsManager`** na API: a unidade é o `Command` do framework, com rollback e
  `UnrecoverableException` quando o próprio rollback falha.

## 7. O que proponho aproveitar, em ordem de valor

1. **`OdcDiff`** (feito): portão de equivalência e relatório de merge sem bridge nem GUI.
2. **Um verbo `replace {de, para}` nas DUAS faixas**, percorrendo os consumidores e chamando `ReplaceReferences` em
   cada um: publicado no ODC, por cast de framework no O11 (é o mesmo método). Repointa consumidores de verdade, e
   é a peça que falta para trocar produtor sem a bridge.
3. **`GetTargetPath` / `ResolveTargetPath`**: endereço estável e reversível para qualquer objeto. Substituiria o
   seletor `#ITipo` que precisei estender para procurar dentro de `IContent`.
4. **`IExpressionProperty` e a AST**: perguntar o tipo esperado antes de escrever, e comparar expressões
   estruturalmente em vez de por string.
5. **`CreateOrTransformObjects` com `ModelObjectDefinition`**: criação em lote com a coleção de destino nomeada,
   dissolvendo a ambiguidade de nomes que hoje se resolve por ranking.
6. **`Undo` e `TransactionCompleted`**: um job que falha no meio poderia reverter em vez de recarregar o arquivo, e o
   contrato de dados poderia vir da lista de objetos tocados, em vez de ser reconstruído por comparação externa.
7. **No O11**: `MoveObject`, `AddDependency`, `RemoveUnusedDependencies`, `SubstituteAndSimplify` e `SetOrderTo` já
   existem na API pública e o kernel não usa nenhum.
8. **Extrair para ação e substituir usos, pelas classes de comando das duas plataformas**, com o presenter headless
   que o adaptador SS11 já constrói. É a refatoração de maior valor e a que menos código nosso exige, porque a
   análise de escopo e a geração de parâmetros já vêm prontas.

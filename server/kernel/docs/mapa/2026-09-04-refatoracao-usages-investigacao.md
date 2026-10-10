# Refatoracao headless no Service Studio 11.55.69: usages, rename, delete, extract

Investigacao somente-leitura do decompilado (ILSpy) em
`C:\Users\andre\GitSSAM\.ssam\local\native-dll-decompile\source\` e do produto Anvil
(`C:\Users\andre\Anvil\src\Anvil.Core`). Abreviaturas de arquivo usadas nas citacoes:

| Abrev. | Arquivo |
|---|---|
| FW | `ServiceStudio.Framework\ServiceStudio.Framework.decompiled.cs` |
| PR | `ServiceStudio.Presenter\ServiceStudio.Presenter.decompiled.cs` |
| BB | `ServiceStudio.BuiltInBehaviors\ServiceStudio.BuiltInBehaviors.decompiled.cs` |
| MI | `OutSystems.Model.Implementation\OutSystems.Model.Implementation.decompiled.cs` |
| V1 | `OutSystems.Model.V1\OutSystems.Model.V1.decompiled.cs` |
| VW | `ServiceStudio.View\ServiceStudio.View.decompiled.cs` |
| Verbs | `C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs` |
| Publisher | `C:\Users\andre\Anvil\src\Anvil.Core\Adapters.SS11\Publisher.cs` |
| HeadlessRuntime | `C:\Users\andre\Anvil\src\Anvil.Core\Adapters.SS11\HeadlessRuntime.cs` |

Nomes `prs#xxxx` sao obfuscados pelo Presenter; sao estaveis dentro de 11.55.69 mas
mudam entre versoes (ver secao 7, riscos).

---

## 0. Resumo executivo

1. **Referers ja existem no modelo carregado e sao publicos**: `AbstractObject.Referers`
   (FW:51204), `HasReferers` (FW:51668), `ReferersOfType<T>()` (FW:52091). O indice e
   persistido no OML e mantido incrementalmente; `RebuildReferers()` so e necessario
   em caso de inconsistencia (o proprio Framework se auto-cura).
2. **Find Usages do Studio roda sem UI**: `ICommandServices.FindUnusedElements`
   (PR:153560) chama exatamente a mesma maquina (`FindCommands.prs#hchycmdi`,
   PR:205963, `[DoNotObfuscate] internal static`) com `MockAggregatorPresenter +
   MockPresenter` (PR:153514-153524) e um `IFindResultsHolder` privado (PR:48136). E o
   mesmo par que `Publisher.Mutate` ja usa (Publisher.cs:154-162).
3. **Rename propaga por chave, nao por texto**: expressoes, SQL e JavaScript guardam
   `ObjectElementReference` (chave do objeto, FW:826752-826795) e regeneram o texto a
   partir de `referedObject.NameForScope` (FW:826760). Renomear = `SetName` dentro de um
   comando (PR:217419-217444 -> PR:214726). O que NAO propaga: literais de texto,
   descricoes, CSS, JS fora de `$parameters/$actions/$roles`, `ExpressionElementReferenceByName`,
   referencias ja quebradas (`InvalidElementReference`), e o nome pode ser
   silenciosamente sufixado se colidir (`AbstractObject.NameClash`, FW:54834).
4. **Delete no Studio NAO bloqueia por uso**: `EditCommands.Delete` (BB:14326-14448)
   chama `Delete()` direto; `AbstractObject.InnerDelete` faz `ReplaceAllReferences(null)`
   (FW:53213) que transforma cada token consumidor em `InvalidElementReference`
   (FW:827905, FW:20961) -> erros de TrueChange. "Delete seguro" e algo que nos
   construimos com o passo 2.
5. **Extract to Action existe pronto** (BB:25996, BB:26808) mas depende de
   `Runtime.Instance.DoSlowOperation` e do clipboard do runtime, que sao `sealed override`
   lancando `NotImplementedException` em `Runtime.DummyImplementation` (FW:2099-2127),
   base do `SsamHeadlessRuntime` (HeadlessRuntime.cs:80). Precisa de um Runtime proprio
   (derivar de `Runtime`, nao de `DummyImplementation`). Extract to Block nao esta no
   decompilado (plugin). Replace All tem nucleo publico e sem UI: `FindResult.Replace`
   (PR:206862).

---

## 1. Como obter os referers de um `AbstractObject`

### 1.1 Superficie publica (Framework)

| Membro | Linha | Notas |
|---|---|---|
| `public IEnumerable<AbstractObject> Referers` | FW:51204-51216 | Resolve cada `CompoundKey` via `GetObject(this)`; com o feature flag `AlwaysOn_RecoverInconsistentReferers` usa `GetReferer` (FW:52039-52050) que, em `MissingObjectException`, dispara `RebuildReferers()` e lanca `RecoverableException`. Forca o carregamento de fragmentos lazy do OML. |
| `public IEnumerable<AbstractObject> LoadedReferers` | FW:51218-51221 | `TryGetObjectIfLoaded` — ignora referers em fragmentos ainda nao carregados. Para "usages" completos usar `Referers`. |
| `public bool HasReferers` | FW:51668 | `!GetRefererCompoundKeys().IsEmpty()` — O(1) para o pre-check de delete. |
| `public IEnumerable<CompoundKey> GetRefererCompoundKeys()` | FW:52029-52032 | Chaves cruas. |
| `public IEnumerable<T> ReferersOfType<T>()` | FW:52091-52095 | Filtro por tipo feito no indice (nao materializa os outros). |
| `public IEnumerable<T> LoadedReferersOfType<T>()` | FW:52097-52101 | Idem, so carregados. |
| `public void AssertValidReferers()` | FW:52052-52077 | Verifica simetria referer/refered; em erro chama `RebuildReferers()` silenciosamente. |

Interface do lado do consumidor (quem referencia): `IReferer` (FW:806678-806685) com
`ReferedObjects`, `ReplaceReferences(prev, new)`, `CleanupReferences(prev)`.
Default de `ReferedObjects` em `AbstractObject` e vazio (FW:51837-51843); ha ~60 overrides
(expressoes, SQL, JS, argumentos, links, tipos, nodes de execucao, etc.).

### 1.2 Internos (so para entender custo e invariantes)

- `ESpace.GetReferers(AbstractObject)` e `internal` (FW:103655-103662); a versao generica
  (FW:103664-103671) devolve vazio se `oml.NeedsReferersRebuild`.
- `ESpace.ReferersManager<RefererType, ReferredType>` e classe privada aninhada (FW:88159)
  que herda `OutSystems.Model.Implementation.ReferersManager` (MI:24417). API base publica:
  `GetReferers(CollectionIndex, ObjectKey)`, `GetReferers(CompoundKey)` e genericos
  (lista em MI:24560-24575). Estrutura: `Dictionary<CompoundKeyPart, HashBag<entry(Type, CompoundKey)>>`
  (MI ~24540-24560) -> lookup O(1) por objeto referido, filtro por tipo via `IsAssignableFrom`.
- Manutencao incremental: `ESpace.AddReferer/RemoveReferer` `internal` (FW:103673-103691),
  chamados pelos proprios referers quando `ReferedObjects` muda; cada add/remove gera uma
  `Operation` de undo (FW:88161-88248).
- **Persistencia**: `ReferersManager.Load(XElementReader)` / `Save(Oml.Writer)` (MI:24572-24574).
  No load, o `ESpace` so reconstroi se `oml.NeedsReferersRebuild` (FW:102552-102554,
  "Rebuilding referers"). Ou seja, apos `ESpace.Load` (ModelHost.cs:21) os referers ja estao
  prontos; **nao chamar `RebuildReferers()` preventivamente** (custo: caminhada por todos os
  objetos, FW:103350-103371, e marca o modulo como modificado via `SetModified()`).
- `RebuildReferers()` e publico (FW:103350) — reservar para recuperacao explicita
  (`InvalidRefererException`).
- Resolucao `CompoundKey -> AbstractObject`: `CompoundKey.GetObject(ESpace)` (FW:776602),
  `TryGetObject(ESpace)` (FW:776620); `Referers` ja faz isso por voce.

### 1.3 Granularidade: quem e o "referer"

O referer e o objeto de menor granularidade que segura a referencia, nao a tela/acao:

- `ParsedExpression` (FW:826850) — `ReferedObjects = NonTypeReferedObjects + ReferedTypes + ReferedImplicitParameters` (FW:826852).
- `AbstractSQLExpression` (FW:20494) e `JavascriptExpression` (FW:35519) — ambos `IObjectWithPropertiesReferedByName, IReferer`.
- `Nodes.AbstractExecuteAction` (FW:228564) referencia a `Action`; `Argument`, `Assignment`,
  `AbstractLink`, `ListType`, `AnonymousStructureAttribute`, `DataSource`, etc.

Para apresentar "tela/acao/caminho", o Studio sobe ate o ancestral mostrado na arvore:
`FindResultsPaneEntry.LocationObject` (VW:4395-4414: `AbstractQuery` mais proximo, senao o
primeiro pai com `AbstractObjectKind.IsShownInESpaceTree`) e `LocationName` (VW:4430-4443:
concatena `DisplayName` com `\` ate `ESpace`/`Reference`).

### 1.4 Custo

- `HasReferers`: lookup de dicionario.
- `Referers`: lookup + N resolucoes de chave (cada uma um lookup no indice do ESpace; pode
  disparar carga lazy de fragmento OML).
- Nenhum `RebuildReferers` necessario. Apos `ESpace.Load`, tudo esta em memoria.

---

## 2. Como o Find Usages do Studio monta a lista

### 2.1 Cadeia de chamadas

1. Comando `FindCommands.FindUsages : AutoRegistryCommand<FindUsages, ICommandTarget>`
   (PR:204495). `InnerAppliesTo` = `abstractObject.SupportsFind` (PR:204525-204528;
   default FW:51941-51951 = `IsUserVisible && !IsSystemObject`). `InnerExecute`
   (PR:204530-204548) pede o painel ao `BottomPanePresenter` e chama
   `prs#hchycmdi(aggregator, obj, IFindResultsHolder pane, nvu: false)`.
2. `internal static void prs#hchycmdi(IAggregatorPresenter, AbstractObject, IFindResultsHolder, bool nvu, CancellationToken)`
   (PR:205962-205966, marcado `[DoNotObfuscate]`) -> `prs#hchycmdk(...)` (PR:205974-206026)
   com o enumerador `prs#hchycmdo(...)`.
3. `prs#hchycmdk` (PR:205974): dedup por `Triplet(Object, (PropertyOwner, Property), (TextSelection, Regex))`
   (PR:205977-205990); filtro `IsESpaceTreeTabVisible(ActiveESpace)` (PR:82381 ->
   PR:44289: regras por tipo de modulo, sem UI). Se `holder.SupportsCancel` usa
   `RuntimeImplementation.DoVerySlowOperation` (PR:206001-206014); senao itera os
   `Action` e para quando `holder.HasResults && nvu` (PR:206017-206025) — `nvu:true` =
   "parar no primeiro achado" (usado por FindUnusedElements).
4. `prs#hchycmdo(Action<FindResult>, AbstractObject obj, bool stopAtFirst, ct)`
   (PR:206085-206374) — o algoritmo:
   - Excecoes de sistema: varre `ErrorHandler`/`RaiseError` (PR:206091-206114).
   - Elemento de referencia de plugin mobile -> `RuntimeUsageFindResult` (PR:206115-206122).
   - **`HashSet<AbstractObject> referers = obj.Referers`** (PR:206140).
   - Familias com "salto": `prs#hchycmdp<TTarget,TNode>` (PR:206376-206412) para
     `ExecuteAction`, `ExecuteScriptAction`, `ExecuteProcess`, `GoToDestination`,
     `SimpleQueryRecord` (PR:206141-206160): emite o no e depois os referers do no
     (ex.: `CallX.Output` em expressoes), com `FindResult.Parent` encadeado.
   - Cada referer restante -> `prs#hchycmdz(null, obj, referer, isTypeUse, obj, null, emit)`
     (PR:206161-206173).
   - Extras por tipo: atributos de `AbstractNamedRecord` (PR:206179-206191), `IdentifierType`
     de entidade (PR:206194-206207), static records (PR:206208-206223), cadeia `IDataSource ->
     AddSource -> DataSource` (PR:206229-206247), `AbstractElementActionSignature`
     (PR:206252-206263), `RoleException` (PR:206268-206283), imagens em CSS por regex
     (PR:206288-206306), recursao em elementos de referencia e WebReference
     (PR:206311-206343).
   - Se `!stopAtFirst`, ordena por `HierarchicalCompare` e por propriedade (PR:206349-206373).
5. `prs#hchycmdz` (PR:206566-206629) — materializa `FindResult`:
   - Porta: `sourceOfFind.IsBeingUsed(referer, refered)` (PR:206568; `public static`
     FW:613338-613387: exclui auto-referencia, objetos invisiveis, `AbstractAttributeValue`,
     `ReferenceStyleSheetImage`, `DataSetImplicitParameter`, etc.).
   - `AnonymousStructureAttribute` / `ListType`: recursao nos referers deles (PR:206577-206597).
   - Referer `IPropertyObject` (expressao/SQL/JS): `propertyObject.GetReferedObjectLocations(refered)`
     (PR:206605) da as `TextSelection` dentro do texto da propriedade; cria um `FindResult`
     por ocorrencia com `Property = AssociatedProperty` (PR:206611-206617).
     Implementacoes: ParsedExpression (FW:827xxx, lista em 2.3), SQL (FW:21377-21397),
     Lightweight (FW:33559).
   - Outros referers: percorre `referer.Properties` e emite para cada propriedade visivel
     cujo valor `== refered` (PR:206620-206628).
6. `FindResult : FindResultsPaneEntry` (PR:206650; base VW:4309). Campos uteis:
   `Object` (VW:4323), `PropertyOwner` (VW:4346), `Property` (VW:4367), `TextSelection`
   (VW:4371), `PropertyDisplayName` (VW:4383), `LocationObject/LocationName` (VW:4395/4430),
   `Element` (VW:4445), `Parent` (PR:206739), `SupportsReplace` (PR:206735),
   `IndexInsideProperty` (PR:206727).

### 2.2 Reutilizavel sem UI — SIM, ja provado pelo proprio Studio

`ICommandServices.FindUnusedElements` (V1:209; impl PR:153560-153573):

```
prs#drgebrbi((ESpace)element.GetESpace(), presenter =>
    FindCommands.prs#hchycmdi(presenter.Aggregator(), (AbstractObject)element, holder, nvu: true));
```

- `prs#drgebrbj` (PR:153514-153524): `IESpaceServices.PrepareForCommandExecution(espace)` +
  `new MockAggregatorPresenter(espace, null, registerAsStaticInstance:false)` +
  `new MockPresenter(aggregator)`. Identico ao `Publisher.Mutate` (Publisher.cs:154-162).
- Holder privado `prs#bvugoepy : IFindResultsHolder` (PR:48136-48176): `SupportsCancel=false`,
  lista de `FindResult`. A interface `IFindResultsHolder` e publica (PR:62544-62554) —
  podemos implementar a nossa.
- `MockAggregatorPresenter.ActiveESpace` (PR:210207) e o proprio espace;
  `DisableCommandCompleteIn` executa a acao (PR:210754-210757); `SelectedEditor` = null
  (PR:210442).
- Nao abre comando (leitura pura); nao usa `DoSlowOperation`.

Duas formas de expor no Anvil:

- **A (fidelidade total)**: reflexao para `ServiceStudio.Presenter.FindCommands.prs#hchycmdi`
  (`BindingFlags.NonPublic | Static`). Localizar pela assinatura
  `(IAggregatorPresenter, AbstractObject, IFindResultsHolder, bool, CancellationToken)` +
  atributo `DoNotObfuscate`, nao pelo nome.
- **B (sem Presenter)**: replica de ~150 linhas de `prs#hchycmdo/prs#hchycmdz` com as APIs
  publicas: `Referers`, `IsBeingUsed`, `IPropertyObject.GetReferedObjectLocations`,
  `Properties`, `GetAttributes()`, `IdentifierType`, `GetStaticRecords()`.

Recomendacao: A com fallback B (B tambem serve como teste cruzado).

### 2.3 Como `GetReferedObjectLocations` acha o trecho

- ParsedExpression: `GetReferedObjectLocations(obj[, context])` (lista de membros em
  FW:826850-829817, itens 54-56) percorre `ReferenceExpressionElement` cujo `Reference` e
  `ObjectElementReference` para `obj`.
- SQL: `AbstractSQLExpression.GetReferedObjectLocations` (FW:21377-21397) usa
  `sqlElements.OfType<ReferenceElement>()` e `GetStartPosition`.

---

## 3. Rename: o que acontece e o que (nao) propaga

### 3.1 O comando do Studio e so "set Name" dentro de um comando

- `RenameCommands.Rename` (PR:217360) apenas inicia edicao in-place; o efeito real e
  `RenameCommands.RenameObject(presenter, IObjectWithWritableName obj, newName)` (PR:217419-217444):
  `Command.Execute(ctx, "Rename <kind>", () => PropertiesCommands.ChangeProperty(obj, obj.NamePropertyDescriptor, newName, ...))`.
- `PropertiesCommands.ChangeProperty` (PR:214726 -> PR:214545): `Command.Execute` +
  `PropertyDescriptor.SetValue`. Nada alem disso e obrigatorio.
- `IObjectWithWritableName` (FW:806480-806487): `NameIsOptional`, `NamePropertyDescriptor`,
  `SetName(string)`. Implementacao tipica: `SetName(value)` -> `SetName(value, SetReason.PropertyChanged)`
  (FW:47615-47618) -> **`value = AbstractObject.NameClash(this, value)`** (FW:47381-47386).
- `AbstractObject.NameClash(obj, name)` (FW:54834-54930): `FixName`, limite de tamanho,
  e **se o nome colide com irmaos (`NameClashHandler.GetNamesToNameClashAgainstChildObj`, FW:54902)
  acrescenta sufixo numerico** (loop FW:54917+). Consequencia: um `rename` headless para um
  nome ja usado nao falha — vira `Nome2`. O verbo precisa pre-checar (chamar `NameClash` e
  comparar) ou ler o nome resultante e reportar.
- Headless hoje: o verbo `set {target, prop:"Name"}` do Anvil (Verbs.cs:121-146) ja faz
  `pi.SetValue` na propriedade V1 dentro de `Publisher.Mutate` (Verbs.cs:41-60).

### 3.2 Por que expressoes continuam validas: ligacao por chave

- Elemento de referencia de expressao: `ObjectElementReference` (FW:826752).
  `DisplayValue => referedObject.NameForScope` (FW:826760); persistencia por chave:
  `Save -> writer.SaveReference(owner, property, Value, referedObject)` (FW:826786-826795).
  No load, `ExpressionElementReference.LoadProperty` (FW:825276-825302) tenta `NameReference`
  (por nome), depois `LoadReference<AbstractObject>` (por chave), senao `InvalidElementReference(texto)`.
- `ParsedExpression.GetText()` **regenera** o texto: `GetExpressionElementText(Scope, expressionElement)`
  (FW:827804-827808; FW:824311). Persistencia da expressao e a arvore de elementos
  (`SaveChildren` -> `saver.SaveChild(null, RootExpressionElement)`, FW:827378-827382), nao o texto.
- SQL: `EntityElement.Text => "{" + ReferenceName + "}"` (FW:23119), `ReferenceName => Reference.DisplayValue`
  (FW:23289); `AbstractSQLExpression.GetText()` concatena `element.Text` (FW:20926-20937).
  Tokens de entidade/atributo ligados a objeto seguem o rename.
- JavaScript (node JavaScript do Reactive): parser liga `$parameters.X`, `$actions.Y`, `$roles.Z`
  (regex FW:36243; binding FW:36258-36292); `ParameterReferenceElement.Text` deriva de
  `ReferenceName` (FW:35376). Qualquer outra mencao no JS e `TextElement` (texto puro).
- `NameForScope` (FW:51332-51342): `Name` (ou `FixName(extended:false)` para nomes estendidos).

### 3.3 O que o Framework faz no rename (hooks)

`AbstractObject` setter de propriedade (FW:53640-53672): invalida verify cache dos referers
(`AffectsReferersValidation`), `RebindRefererExpressions` (`AffectsRefererExpressionsTypes`),
e se `IsNameProperty && !nameClashPending` -> `OnAfterNameChange()` (FW:53692-53736):

1. Invalida verify caches proprios e dos referers com mensagens (FW:53694-53698).
2. `IReferedInScope.InvalidateTopLevelScopeEntriesCachesOfPossibleReferers()` (FW:53699-53702).
3. `OwnerESpace.OnReferedByNameNameChange(obj)` -> `RebindManager.OnNameChange` (FW:103611-103613 -> FW:88041-88120):
   **cura referencias quebradas por nome**: para cada `IObjectWithPropertiesReferedByName`
   registrado sob o nome novo (`UnboundReferencesNames`, ParsedExpression FW:827351-827360),
   chama `Rebind(renamedObj)` (ParsedExpression FW:827398-827406). Ou seja, renomear `X` para
   o nome que uma expressao quebrada espera religa a expressao.
4. `Referers[i].OnReferedObjectNameChangeWhenLoaded(this)` (FW:53716-53720). Default: `ForceViewRefresh`
   (FW:54192-54195). Overrides relevantes (mapa completo por classe obtido por awk):
   - `ParsedExpression` (FW:828071-828075): notifica o pai (`OnAfterExpressionTextChange`).
   - `AbstractExpression` (FW:824483-824493): `GroupByAttribute`/`AggregateAttribute.RefreshName()`.
   - `Nodes.AbstractExecuteAction` (FW:229752-229759) e `ScriptNodes.ExecuteScriptAction`
     (FW:716312-716319): `RefreshName()` — **o no de execucao e renomeado automaticamente**
     quando a acao chamada muda de nome (salvo `CustomName`).
   - `ListType` (FW:221892), `DataSource` (FW:81825), `AnonymousStructureAttribute` (FW:67104),
     `WebBlockInstance` (FW:353432/515102), `ExecuteProcess` (FW:364520), `Timer` (FW:439400),
     `SimpleQueryRecord` (FW:722050), `SendEmail`, `TriggerEvent`, `ErrorHandler`, etc.
5. `HandleRebindCustomSynchronizationsAfterNameChangeAndDelete()` (FW:53722; def FW:53122).
6. `ForEachNameUsedInReferenceDependentChildren` (FW:53726-53730; def perto de FW:54xxx —
   `ForEachNameDependentChildren`): filhos cujo nome deriva do pai (ex.: entity actions
   `CreateX/GetX`) recebem `OnAfterNameChange` + `IncreaseViewGenerationAndRefreshReferers`.
7. `ReferersOfType<ParsedExpression>().Apply(exp => exp.Rebind())` (FW:53733-53736):
   re-resolve/revalida tipo de cada expressao consumidora.

Portanto: **nao existe "ReplaceInExpressions" textual**; o texto e derivado. `Reparse()`
(FW:824503-824506) existe mas nao e chamado no rename.

### 3.4 O que NAO propaga (lista para o relatorio do verbo)

| Caso | Evidencia | Consequencia |
|---|---|---|
| Literais de texto (`"…"`), Description, Label, Tooltip, URLs digitadas | nao sao `IReferer`; Find Usages nem os lista (so Find Text por regex, PR:206028-206081) | texto antigo permanece |
| `ExpressionElementReferenceByName` (FW:825303) | ligado por nome (`NameReference`, FW:825282-825286), tipo `Name`, usado por runtime properties/iteracao | so rebind por nome |
| `InvalidElementReference` (ja quebrado) | FW:825950; so cura se o nome novo coincidir (`RebindManager.OnNameChange`) | continua quebrado |
| CSS: classes/imagens | `FindStyleUsages` e regex (PR:204558-204625); imagens em CSS so quando `!SupportsReferenceTrackingInCss` (PR:206291-206306) | texto |
| JavaScript fora de `$parameters/$actions/$roles` | parser FW:36243; resto e `TextElement` | texto |
| SQL: strings/comentarios | `ClearStringLiteralsAndComments` (FW:21372-21375) — nao sao elementos de referencia | texto |
| Consumidores em OUTROS modulos | referers sao por ESpace (`obj.OwnerESpace.MustBe(referer.OwnerESpace)`, FW:103676); cross-module = `FindUsagesInAllESpaces` (PR:187533) via servidor | exige refresh de referencias nos consumidores |
| Nome colidente | `NameClash` sufixa (FW:54917) | nome final != pedido |
| `OriginalName` de elementos referenciados | `IObjectWithWritableOriginalName` (FW:806488) | nome de exibicao local, nao o do produtor |

---

## 4. Delete: como o Studio decide e o que quebra

### 4.1 Nao ha "cannot delete: used by"

- `EditCommands.Delete` (BB:14231): `CommandCanExecute` (BB:14293-14304) = `widget.CanBeDeleted()`
  ou `obj.CanBeUserDeleted` (FW:51855-51864: `!IsReadOnly && IsUserVisible`). Nenhuma
  consulta a referers.
- `CommandExecute` (BB:14326-14448): para cada alvo, `ITopLevelReferenceElement.TryDelete()`
  (BB:14389-14396) ou `Links.Relationship.Attribute.Delete()` (BB:14398-14400) ou
  **`abstractObject3.Delete()`** (BB:14403). Envolvido em `Runtime.Instance.DoSlowOperation`
  (BB:14328) — ver 5.1.
- So elementos de referencia (`ReferenceEntity`, `IReferenceWebBlock`, `ReferenceImage`)
  checam uso: `TryDelete` (FW:610532-610580) usa `HasNonHiddenReferenceElementReferer` e,
  se em uso, marca `Hidden = true` em vez de apagar.

### 4.2 O que `Delete()` faz aos consumidores

`AbstractObject.Delete()` (FW:53169-53173) -> `AssertSelfAndAllChildrenValidReferers()` +
`InnerDelete()` (FW:53174-53278):

1. `ModelEventsHandler.DeletingObject`, `OnBeforeDelete` (-> `OnDeletePreparation`, FW:53143-53160).
2. Marca subarvore `IsZombie`, `wasDeleted = true`, `OnStartingToDelete`.
3. `UndoManager.OnDelete`; **`this.ReplaceAllReferences(null)`** (FW:53213; extensao
   FW:609229-609275): enquanto `obj.HasReferers`, pega o primeiro referer e chama
   `referer.ReplaceReferences(obj, null)` (FW:609278-609303), com 3 tentativas e
   `RebuildReferers` em inconsistencia.
   - ParsedExpression: `ClearReference(previousObject.NameForScope)` (FW:827895-827905) ->
     token vira `InvalidElementReference` com o nome antigo; `Rebind()`/`OnPropertyObjectUpdate`
     (FW:827945-827948).
   - SQL: `element.Reference = new InvalidElementReference(element.ReferenceName)` (FW:20961-20966).
   - Outros referers (Argument, links, nodes): propriedade fica `null` (`ReplaceReferences` proprio).
4. Limpa as referencias que o proprio objeto faz (FW:53214-53229, `referer.ReplaceReferences(refered, null)`).
5. Apaga filhos recursivamente, `DeleteVerifyCache`, `UnregisterCompilationUnit`,
   `InvalidateTopLevelScopeEntriesCachesOfPossibleReferers`, `OwnerESpace.OnDelete(this)`
   (FW:103693-103698: `referersManager.OnDelete`, `rebindManager.UnregisterAll`),
   `RemoveFromParent`, `OnAfterDelete`.

Resultado: o texto dos consumidores fica igual, mas cada token quebrado gera erro de
TrueChange (`Verify()`), exatamente o comportamento visivel no Studio.

### 4.3 API para verificar ANTES de apagar

- Barato: `obj.HasReferers` (FW:51668). Para entidades, lembrar atributos, `IdentifierType`
  e static records (o Find Usages agrega isso: PR:206179-206223).
- Completo: o `usages` da secao 2 (path A com `nvu:true` para "existe algum?").
- Porta publica V1: `ICommandServices.FindUnusedElements(IObjectSignature, ISet<IObjectSignature>)`
  (V1:209; impl PR:153560) -> `(unused, results)`. A interface e `internal` no V1
  (V1:203), mas o proprio `AbstractObject` a obtem por `OutSystems.Model.ServicesProvider.Instance.GetService<ICommandServices>()`
  (FW:52004-52006); reflexao resolve (Anvil ja faz isso com `ServicesProvider` em
  HeadlessRuntime.cs:49-56).
- Delete com substituicao: `DeleteAndSetReplacement(replacement)` (FW:53164-53168) so
  registra a substituicao para merge/undo; a troca real de consumidores e o Replace
  (`FindResult.Replace(source, replacement, text)`, PR:206862-206871 -> `IPropertyObject.ReplaceReferencesForFindAndReplace`
  PR:206926-206929; SQL FW:20945-20948; ParsedExpression lista item 43).
- Elementos de referencia: `IReferenceElementWithUsage.IsUnused` (FW:806660-806666);
  `ICommandServices.RemoveUnusedReferences` (V1:207).

---

## 5. Comandos de refatoracao prontos e viabilidade headless

### 5.1 Restricao transversal: `Runtime.DummyImplementation`

`SsamHeadlessRuntime : Runtime.DummyImplementation` (HeadlessRuntime.cs:80). Em
`DummyImplementation` (FW:1963) sao **`sealed override` que lancam `NotImplementedException`**:
`ShowMessage` (4 sobrecargas, FW:2034-2052), `DoSlowOperation` (FW:2099-2107),
`DoVerySlowOperation` (FW:2109-2112), `CopyToClipboard` (FW:2119-2122), `GetClipboardOmlData`
(FW:2124-2127). Em `Runtime` elas sao `abstract` (FW:2586-2618; 32 membros abstratos no
total, FW:2380-2800). Qualquer comando do Presenter/BuiltInBehaviors que passe por
`Runtime.Instance.DoSlowOperation` morre no headless atual. Solucao: `AnvilRuntime : Runtime`
implementando `DoSlowOperation = operation()`, `ShowMessage = throw/registrar`, clipboard em
memoria (byte[] + string). Custo: implementar os 32 abstratos (maioria devolve null/no-op;
`GetAggregator` e `GetDeveloperId` ja existem em HeadlessRuntime.cs:69-89).

### 5.2 Inventario

| Comando | Onde | Nucleo sem UI? | Dependencias headless |
|---|---|---|---|
| Find Usages | PR:204495 / PR:205963 | **Sim** (2.2) | MockAggregatorPresenter; holder proprio |
| FindUnusedElements | PR:153560 | **Sim** | idem, ja pronto |
| Rename | PR:217419 -> PR:214726 | **Sim** (= SetName no comando) | nada |
| Delete | BB:14326 | nucleo = `AbstractObject.Delete()` (FW:53169) | o comando usa `DoSlowOperation` (BB:14328) — chamar `Delete()` direto |
| Replace All / Replace usages | PR:217691 (`ReplaceCommands.Replace`) | nucleo `prs#grhhqgqm` (PR:217701-217715) itera `FindResult.Replace` (publico, PR:206862) | `Replace` usa `DoSlowOperation` (PR:217705); `GetReplaceWarnings` (PR:217718) abre e faz rollback de comando; o dialogo de escolha (PR:48732-48783) e UI. Reimplementar o loop com `FindResult.Replace` |
| Extract to Action | BB:25996 (`ExtractToAction`), BB:26656 (`ExtractToActionCommand`), comandos BB:26599/26629 | `ExtractToActionCommand.Execute(selection, presenter, enableForPreparation, …)` (BB:26808-26829); `Validate` sem UI (BB:26775-26806), falha so telemetria | `ExtractToAction.Execute` (BB:26047-26132) usa `Runtime.Instance.DoSlowOperation` (BB:26052), `DisableCommandCompleteIn` (mock ok, PR:210754), Cut/Paste via `ClipboardManager` + `Runtime.GetClipboardOmlData/CopyToClipboard` (BB:26580-26596), `ShowStars` (BB:26134). Precisa do 5.1 |
| Extract to Block | so `InteractionItemOrder` em PR:54211-54213 | — | implementacao nao esta no decompilado (plugin NRWidgets) |
| Convert to Advanced Query | PR:199426 (`ServerCommand`) | nao | testa a query no servidor + `ShowMessage` (PR:199463) |
| Convert module (Reactive/Library) | PR:203833, PR:203922 | fora de escopo | |
| Wrapper generators (Create/Update/Delete wrappers) | PR:184734-184941 | nao investigado | |
| Duplicate / Serialize / DeserializeInto | PR:153577-153610 | **Sim** (ja usam Mock*) | Anvil `duplicate` ja usa (Verbs.cs:183-190) |
| Move to folder | nao ha comando dedicado; e `set` da propriedade Folder (`ValidateFolderChange`, FW:55374) | sim | nada |

---

## 6. Plano de implementacao (Anvil)

Tudo entra em `ModelSession` (Verbs.cs) como novos `op`s, mantendo o contrato "um job =
um comando" (`Publisher.Mutate`, Publisher.cs:154-162). Leituras (`usages`) nao abrem comando.

### 6.1 Infra comum (Adapters.SS11)

1. `StudioInternals` (reflexao, pinada por versao do `ServiceStudio.Framework.dll`):
   - `FindUsagesCore`: `typeof(FindCommands).GetMethods(NonPublic|Static)` filtrado por
     parametros `(IAggregatorPresenter, AbstractObject, IFindResultsHolder, bool, CancellationToken)`
     e atributo `DoNotObfuscate` (PR:205962). Falhar alto se nao houver exatamente 1.
   - `CommandServices`: `ServicesProvider.Instance.GetService<ICommandServices>()` por reflexao
     (mesmo padrao de HeadlessRuntime.cs:49-56) para `FindUnusedElements`/`RemoveUnusedReferences`.
2. `UsagesHolder : IFindResultsHolder` (interface publica PR:62544): `SupportsCancel=false`,
   `List<FindResult>`.
3. `UsageEntry` (DTO JSON): `refererKey/type/name` (`FindResult.Object`), `ownerKey/name`
   (`PropertyOwner`), `property` (`Property.Name`), `propertyDisplayName`, `selection {start,len}`,
   `snippet` (texto da propriedade via `Property.GetStringRepresentation(owner, value, false)`,
   como em PR:207005), `locationKey/path` (`LocationObject`, `LocationName`), `element`,
   `parentKey` (`FindResult.Parent`), `supportsReplace`.
4. Presenter mock reutilizado: `new MockAggregatorPresenter(espace, null, false)` +
   `new MockPresenter(agg)` (Publisher.cs:160-161). Antes: `IESpaceServices.PrepareForCommandExecution`
   (PR:153516) — equivalente ao `PrepareForSave` que `Mutate` ja invoca.

### 6.2 Verbo `usages {target, first?:bool, max?:int}`

- Resolve `target` (Verbs.cs:224-262; o objeto V1 **e** o `AbstractObject`).
- Se `target is Nodes.DiagramEntity` -> `.Entity` (PR:204535-204538).
- Se `!SupportsFind` (FW:51941) -> devolver `{supported:false}`.
- Chama `FindUsagesCore(agg, obj, holder, nvu:first)`; sem comando aberto.
- Saida: `{count, byElement:{kind:n}, byLocation:[{path,key,count}], entries:[UsageEntry…]}`.
- Fallback B (feature flag): `obj.Referers` + `IsBeingUsed` (FW:613338) +
  `GetReferedObjectLocations` + loop de `Properties` (PR:206620-206628), mais atributos/
  IdentifierType/static records para `AbstractNamedRecord`/`AbstractEntity`.
- Custo esperado: ms (lookups de dicionario + resolucao de chaves); carga lazy de
  fragmentos pode aparecer na primeira chamada.

### 6.3 Verbo `rename {target, name, dryRun?:bool}`

Pre:
1. `obj is IObjectWithWritableName w && !w.NamePropertyDescriptor.IsReadOnly(obj)` (PR:217365).
2. `string final = AbstractObject.NameClash(obj, name)` (FW:54834). Se `final != name` ->
   recusar com `{reason:"name_clash", suggested: final}` (evita o sufixo silencioso).
3. Snapshot: `usages` completo; para cada `IPropertyObject` referer, `GetText()`
   (ParsedExpression FW:827804; SQL FW:20926; JS FW:36047); nomes dos referers que sao
   `AbstractExecuteAction/ExecuteScriptAction` (auto-rename, FW:229752/716312) e dos filhos
   name-dependent (`ForEachNameDependentChildren`); `Verify()` errors count do espace e dos
   referers (`GetVerifyErrors()`, FW:53376).
4. Find Text do nome antigo (regex whole-word, `FindCommands.GetFindTextRegex`, PR:206414,
   publico) sobre `GetPropertiesInOrder(…, forFindText:true)` de todos os objetos
   (PR:206040-206060 + PR:206066-206081) — lista de **suspeitos nao propagaveis** (literais,
   URLs, CSS, JS solto, descricoes).

Mutacao (`Publisher.Mutate`): `w.SetName(name)` (FW:806486) — ou o `set` V1 existente.

Pos:
5. Reler os mesmos referers: texto novo != antigo -> `propagated[]`; nomes de nodes que
   mudaram -> `autoRenamed[]`; `Verify()` delta -> `newErrors[]` (esperado 0);
   `notPropagated[]` = suspeitos do passo 4 que ainda contem o nome antigo.
6. `dryRun` = executar dentro de `Command.Execute` e `Command.RollbackCurrentCommand(agg)`
   (padrao de `GetReplaceWarnings`, PR:217718-217727).

### 6.4 Verbo `delete {target, force?:bool, replaceWith?:ref}`

1. `HasReferers` (FW:51668) rapido; se true, `usages` completo (para entidades inclui
   atributos/IdentifierType/static records automaticamente pela maquina do Studio).
2. `replaceWith`: dentro do comando, para cada `FindResult` com `SupportsReplace`, chamar
   `fr.Replace(target, replacement, null)` (PR:206862); coletar `Replaced` (PR:206745).
   Aviso de compatibilidade de atributos entre records: logica em `prs#grhhqgqn`
   (PR:217730-217760) — replicar so a contagem/nome/tipo de atributos.
3. Se restam consumidores e `!force` -> recusar com a lista. Com `force` -> `target.Delete()`
   (V1:810 / FW:53169; Anvil Verbs.cs:192-198 ja faz) e devolver `brokenConsumers[]` =
   `Verify()` delta (erros novos, com `ObjectIdentifier`/caminho via `ModelHost.ValidationDetails`,
   ModelHost.cs:79-100).
4. Elementos de referencia (`ITopLevelReferenceElement`): usar `TryDelete()` (FW:610532) e
   reportar `hidden` vs `deleted`.

### 6.5 Verbos derivados baratos

- `unused {target}`: `ICommandServices.FindUnusedElements` (PR:153560) -> `{unused, results}`.
- `replace {from, to}`: 6.4 passo 2 sem o delete.
- `remove_unused_references`: `ICommandServices.RemoveUnusedReferences` (V1:207).
- `extract_to_action {nodes[], name?}`: **spike** apos o 5.1 (AnvilRuntime : Runtime):
  `ExtractToActionCommand.Validate` (BB:26775) para pre-validar e `ExtractToActionCommand.Execute(selection, presenter)`
  (BB:26808); verificar `ShowStars` (BB:26134) e o Cut/Paste com `MockPresenter`.

### 6.6 Como validar (prova viva, sem Studio aberto)

Fixture (via verbos `create/set/link` ja existentes): Entity `E` com atributo `A`;
Aggregate com filtro e sort usando `E.A`; Server Action com `Assign` (`x = GetE.List.Current.E.A`)
e `Argument` de outra action recebendo `E.A`; AdvancedQuery com `{E}.[A]`; Screen Reactive
com node JavaScript usando `$parameters.P` (P input) e um literal `"A"` num Text.

1. `usages E.A` antes: N entradas; guardar chaves.
2. `rename E.A -> A2`: `propagated` cobre aggregate/assign/argument/SQL; `notPropagated`
   lista o literal `"A"`; `newErrors == 0`; `Verify()` total igual ao de antes.
3. `usages E.A2` depois: mesmas chaves de referer (N), textos com `A2`.
4. `rename E.A2 -> <nome de irmao>`: recusado por `name_clash`.
5. `delete E.A2` sem force: recusado com N consumidores. Com `force`: `brokenConsumers`
   == N (erros TrueChange nos mesmos objetos). `delete` de variavel local sem uso: 0 erros.
6. `save` + `load` (ModelHost.RoundTrip, ModelHost.cs:47-72) e repetir 3 para provar que a
   ligacao por chave sobrevive ao OML (`ObjectElementReference.Save`, FW:826786).
7. Publish no ss1 (Publisher.Publish) para fechar com "0 erros" de compilacao.
8. Cronometrar: `usages` (esperado < 50 ms num modulo de 300 objetos), `rename`
   (dominado por `Rebind` dos referers + `Verify`).

---

## 7. Riscos e cuidados

- Nomes obfuscados (`prs#hchycmdi`, `prs#bvugoepy`): localizar por assinatura/atributo e
  pinar a versao `11.55.69`; teste de contrato que falha se a resolucao devolver 0 ou >1.
- `Runtime.DummyImplementation` bloqueia qualquer comando com `DoSlowOperation`/clipboard/
  `ShowMessage` (FW:2034-2127). Find Usages, rename, delete e replace nao passam por eles
  quando chamados no nucleo; Extract to Action passa.
- `Verify()` chama `msg.ShouldBeDisregarded(Runtime.Instance.GetAggregator(OwnerESpace))`
  (FW:53390) — o `GetAggregator` mock do Anvil (HeadlessRuntime.cs:82-86) ja cobre.
- `Referers` forca carga de fragmentos lazy; nao usar `LoadedReferers` para "usages".
- Referers sao por modulo; cross-module exige baixar consumidores (HeadlessSession) e rodar
  `usages` em cada um, como faz `FindUsagesInAllESpaces` (PR:187533) com a lista do servidor.
- `NameClash` sufixa em silencio (FW:54917): pre-checar sempre.
- Delete de elemento de referencia usa `TryDelete` e pode apenas ocultar (FW:610566-610578).

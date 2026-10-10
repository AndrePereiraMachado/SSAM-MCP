# Mapa de capacidades (gerado)

Arquivos `criar-<fixture>.json/.md` sao gerados por `anvil prove` sobre o catalogo e um fixture por runtime. Nao editar a mao.

## Fila de descoberta (por runtime)

### blank-service

- tipos: {'no-parent': 68, 'created-needs-config': 30, 'not-allowed': 22, 'created': 10, 'skipped': 6, 'created-with-messages': 5, 'needs-args': 3, 'failed': 1}
- sem pai alcancavel (68): IAction, IAddSourceOperation, IAggregateAttribute, IAliasedSource, IApplication, IBlock, IBlockEvent, IButtonWidget, ICalculatedAttribute, ICellWidget, ICheckBoxWidget, ICombineSourcesOperation, IComboBoxWidget, IComment, IContainerWidget, IDataAction, IDownloadNode, IESpace, IEditRecordWidget, IEmail, IEntity, IEntityAttribute, IEntry, IEvent, IExpressionWidget, IExtendedProperty, IExtension, IExtensionResource, IExternalSite, IFilter, IGoToDestination, IGroupByAttribute, IGroupByOperation, IIfBranchWidget, IIfWidget, IInputFilenameWidget, IInputPasswordWidget, IInputWidget, IJoin, IKey, ILinkOnClick, ILinkWidget, IListRecordsWidget, ILocalizedImage, IMobileBlock, IMobileBlockInstanceWidget, IMobileScreen, IMobileWidget, IOnExceptionAction, IPlaceholderContentWidget, IPlaceholderWidget, IPreparation, IRadioButtonWidget, IRowWidget, IScreen, IScreenAction, IScreenAggregate, IShowRecordWidget, ISolution, ISort, ITableRecordsWidget, ITableWidget, ITextWidget, IWebBlock, IWebBlockInstanceWidget, IWebEmail, IWebScreen, IWebWidget
- needs-args: ICommentConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ISQLOutput: InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignature); IDecisionConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode)
- failed: IImage: InvalidOperationException: Image binary cannot be null: Object not set; IDownloadNode: NullReferenceException: Object reference not set to an instance of an object.; ICallback: ArgumentException: An item with the same key has already been added. Key: _No7876VYE20fpsPL5feXQ.#On; IEndNode: NullReferenceException: Object reference not set to an instance of an object.

### reactive-ui

- tipos: {'created-needs-config': 39, 'not-allowed': 33, 'no-parent': 27, 'created': 25, 'created-with-messages': 9, 'skipped': 6, 'needs-args': 4, 'failed': 2}
- sem pai alcancavel (27): IAction, IAddSourceOperation, IAggregateAttribute, IAliasedSource, IApplication, ICalculatedAttribute, ICombineSourcesOperation, IDownloadNode, IESpace, IEntity, IEntityAttribute, IEntry, IExtension, IExtensionResource, IFilter, IGoToDestination, IGroupByAttribute, IGroupByOperation, IJoin, IKey, ILinkOnClick, IPreparation, ISolution, ISort, IWebBlock, IWebEmail, IWebScreen
- needs-args: ICommentConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ISQLOutput: InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignature); IDecisionConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ILocalizedImage: InvalidOperationException: CreateLocalizedImage needs arg 'locale' (ILocale)
- failed: IImage: InvalidOperationException: Image binary cannot be null: Object not set; IDownloadNode: InvalidOperationException: Nodes of type IDownloadNode are not allowed in IDataAction or eSpaces of ; ICallback: ArgumentException: An item with the same key has already been added. Key: EspKGIhVNUWVXwNLCygsWg.#On; IEndNode: NullReferenceException: Object reference not set to an instance of an object.; IOnExceptionAction: ArgumentException: An item with the same key has already been added. Key: B4kRGvrnOEmQonA8ir4Pyg.#Fl

### mobile-ui

- tipos: {'created-needs-config': 39, 'not-allowed': 34, 'no-parent': 27, 'created': 24, 'created-with-messages': 10, 'skipped': 6, 'needs-args': 4, 'failed': 1}
- sem pai alcancavel (27): IAction, IAddSourceOperation, IAggregateAttribute, IAliasedSource, IApplication, ICalculatedAttribute, ICombineSourcesOperation, IDownloadNode, IESpace, IEntity, IEntityAttribute, IEntry, IExtension, IExtensionResource, IFilter, IGoToDestination, IGroupByAttribute, IGroupByOperation, IJoin, IKey, ILinkOnClick, IPreparation, ISolution, ISort, IWebBlock, IWebEmail, IWebScreen
- needs-args: ICommentConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ISQLOutput: InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignature); IDecisionConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ILocalizedImage: InvalidOperationException: CreateLocalizedImage needs arg 'locale' (ILocale)
- failed: IImage: InvalidOperationException: Image binary cannot be null: Object not set; IDownloadNode: InvalidOperationException: Nodes of type IDownloadNode are not allowed in IDataAction or eSpaces of ; ICallback: ArgumentException: An item with the same key has already been added. Key: OHqd8Dlq6EONW7xU6At0_A.#On; IEndNode: NullReferenceException: Object reference not set to an instance of an object.

### traditional-ui

- tipos: {'created-needs-config': 42, 'created': 39, 'no-parent': 23, 'not-allowed': 21, 'created-with-messages': 8, 'skipped': 6, 'needs-args': 4, 'failed': 2}
- sem pai alcancavel (23): IAction, IAddSourceOperation, IAggregateAttribute, IAliasedSource, IApplication, ICalculatedAttribute, ICombineSourcesOperation, IDataAction, IESpace, IEntity, IEvent, IExtension, IExtensionResource, IFilter, IGroupByAttribute, IGroupByOperation, IJoin, IKey, IMobileBlock, IMobileScreen, IScreenAggregate, ISolution, ISort
- needs-args: ICommentConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ISQLOutput: InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignature); IDecisionConnector: InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode); ILocalizedImage: InvalidOperationException: CreateLocalizedImage needs arg 'locale' (ILocale)
- failed: IImage: InvalidOperationException: Image binary cannot be null: Object not set; IDownloadNode: InvalidOperationException: Nodes of type IDownloadNode are not allowed in IOnExceptionAction or eSpa; ICallback: ArgumentException: An item with the same key has already been added. Key: JhVHjNqutE+hIWDtcTrFAA.#On; IEndNode: InvalidOperationException: Nodes of type IEndNode are not allowed in IOnExceptionAction or eSpaces o; IPreparation: ArgumentException: An item with the same key has already been added. Key: AB72AaFvZ0KHIik9GRLCWQ.#Pr; ILinkOnClick: ArgumentException: An item with the same key has already been added. Key: FWwyCOVbe0qeBKydXpjONQ.#On


## Adicionar referencias novas (Manage Dependencies) headless: RESOLVIDO na investigacao de 2026-09-04

O Model API V1 tem, publico, `IESpace.RefreshDependencies(params IShareable[])` (V1:466): clona os elementos do produtor
(carregado headless no mesmo processo, `Public` e valido) para um ESpace descartavel, monta um MatchTree e faz o merge com
`SetIsChecked(deps, children)`, ou seja ADICIONA elementos ainda nao referenciados com dependencias. E `AddDependency(IShareable)`
(V1:464) adiciona um elemento sem merge. Limite: o `Reference` fica com `ReferenceHash` vazio (setar com o hash do catalogo ou
correr o refresh a seguir) e o OML do produtor deve ser a versao publicada. Relatorio completo com todas as linhas:
`docs/mapa/2026-09-04-add-references-investigacao.md`. Verbo `reference` no runtime dos verbos (ver AGENTS.md).

## (historico) Aberto: adicionar referencias novas (Manage Dependencies) headless

O Model API V1 so refresca referencias existentes (`ICommandServices.RefreshReferences(espace, signatures, ownerAppKey, dbName)`,
ja usado em `Adapters.SS11/ReferenceRefresher.cs`). Nao ha `AddReferences` publico. No Studio a operacao vive em
`ServiceStudio.Presenter.ReferencesManager` (decompilado: classe em Presenter:224787; `InitializeAddReferences(CancellationToken,
IEnumerable<ObjectKey> produtores)` em 226397): carrega as assinaturas dos produtores (`ReferencesESpace.LoadSignatures`, do servidor),
monta um `MatchTree` entre o modulo e o "ReferencesESpace" e aplica a selecao de elementos. Caminho provavel para o produto:
(1) obter a assinatura do produtor pela sessao headless (`HeadlessSession.GetReferenceSignature`, ja existe), (2) construir a
`Reference` com os elementos escolhidos e (3) aplicar por `RefreshReferences` com a assinatura completa. Enquanto isso, os fixtures
de template ja referenciam os 120 blocos publicos do OutSystemsUI, entao os padroes de UI ja entram sem esse passo.

# Mapa de capacidades, coluna criar: blank-service (gerado 2026-09-05T00:08:10)

Tipos por melhor estado: no-parent=106, created-needs-config=41, not-allowed=23, created=21, created-with-messages=14, skipped=6, needs-args=3.

Pares: no-parent=1636, skipped=328, created-needs-config=72, not-allowed=47, created=29, created-with-messages=20, failed=11, needs-args=4.

| Tipo | Melhor estado | Pais que criam | Mensagens (amostra) | Erro (amostra) |
|---|---|---|---|---|
| IAction | no-parent |  |  |  |
| IActivityOutputParameter | created | IAutomaticActivityNode, IConditionalStartNode, IWaitNode |  |  |
| IAddSourceOperation | no-parent |  |  |  |
| IAdvancedHtml | no-parent |  |  |  |
| IAggregateAttribute | no-parent |  |  |  |
| IAggregateNode | created-with-messages | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidDataSet_NoEntity |  |
| IAjaxRefreshNode | not-allowed |  |  | InvalidOperationException: Ajax Refresh objects can't be children of On Activity Close obj |
| IAliasedSource | no-parent |  |  |  |
| IApplication | no-parent |  |  |  |
| IAssignment | created-with-messages | IAssignNode | Error:InvalidVariable_UnknownVarIn; Error:ExpressionRequiredExpression |  |
| IAssignNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IAttachFileNode | not-allowed |  |  | InvalidOperationException: Attach File objects can't be children of On Activity Close obje |
| IAutomaticActivityNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IBinaryMetadata | skipped |  |  |  |
| IBlock | no-parent |  |  |  |
| IBlockEvent | no-parent |  |  |  |
| IBooleanMetadata | skipped |  |  |  |
| IButton | no-parent |  |  |  |
| IButtonGroup | no-parent |  |  |  |
| IButtonGroupItem | no-parent |  |  |  |
| IButtonWidget | no-parent |  |  |  |
| ICalculatedAttribute | no-parent |  |  |  |
| ICallback | created-needs-config | IConditionalStartNode, IWaitNode | Error:InvalidFlow_NoStart | ArgumentException: An item with the same key has already been added. Key: +qM0m5IwU0++wD6w |
| ICellWidget | no-parent |  |  |  |
| ICheckbox | no-parent |  |  |  |
| ICheckBoxWidget | no-parent |  |  |  |
| IClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IClientAction | not-allowed |  |  | InvalidOperationException: Client Action objects can't be children of Module objects |
| IClientEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IClientVariable | not-allowed |  |  | InvalidOperationException: Client Variable objects can't be children of Module objects |
| ICombineSourcesOperation | no-parent |  |  |  |
| IComboBoxWidget | no-parent |  |  |  |
| IComment | no-parent |  |  |  |
| ICommentConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IActionNode) |
| ICommentNode | created | ICallback, IProcess, IAutomaticActivityNode, IDecisionNode |  |  |
| IConditionalStartNode | created-needs-config | IProcess | Error:RequiredConnector_Out |  |
| IContainer | no-parent |  |  |  |
| IContainerWidget | no-parent |  |  |  |
| IDataAction | no-parent |  |  |  |
| IDateTimeMetadata | skipped |  |  |  |
| IDecisionConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode) |
| IDecisionNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IDecisionOutcomeNode | created-needs-config | IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Decision Outcome objects can't be children of On Activity Close |
| IDestinationNode | not-allowed |  |  | InvalidOperationException: Destination objects can't be children of On Activity Close obje |
| IDownloadNode | no-parent |  |  | InvalidOperationException: Nodes of type IDownloadNode are not allowed in ICallback or eSp |
| IDropdown | no-parent |  |  |  |
| IEditableTable | no-parent |  |  |  |
| IEditableTableCell | no-parent |  |  |  |
| IEditRecordWidget | no-parent |  |  |  |
| IEmail | no-parent |  |  |  |
| IEndNode | created-needs-config | ICallback, IProcess, IAutomaticActivityNode | Error:RequiredConnector_In | NullReferenceException: Object reference not set to an instance of an object. |
| IEntity | no-parent |  |  |  |
| IEntityAttribute | no-parent |  |  |  |
| IEntry | no-parent |  |  |  |
| IESpace | no-parent |  |  |  |
| IEvent | no-parent |  |  |  |
| IExcelToRecordListNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExceptionHandlerNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out |  |
| IExecuteClientActionNode | not-allowed |  |  | InvalidOperationException: Run Client Action objects can't be children of On Activity Clos |
| IExecuteProcessNode | created-needs-config | IProcess | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExecuteServerActionNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExpression | no-parent |  |  |  |
| IExpressionWidget | no-parent |  |  |  |
| IExtendedProperty | no-parent |  |  |  |
| IExtension | no-parent |  |  |  |
| IExtensionResource | no-parent |  |  |  |
| IExternalSite | no-parent |  |  |  |
| IFilter | no-parent |  |  |  |
| IFolder | created | IESpace |  |  |
| IForEachNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IForm | no-parent |  |  |  |
| IGoToDestination | no-parent |  |  |  |
| IGroupByAttribute | no-parent |  |  |  |
| IGroupByOperation | no-parent |  |  |  |
| IHeaderCell | no-parent |  |  |  |
| IHumanActivityNode | not-allowed |  |  | InvalidOperationException: Human Activity objects can't be children of Process objects |
| IIcon | no-parent |  |  |  |
| IIfBranchWidget | no-parent |  |  |  |
| IIfNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IIfWidget | no-parent |  |  |  |
| IImage | no-parent |  |  | InvalidOperationException: Image binary cannot be null: Object not set |
| IInput | no-parent |  |  |  |
| IInputFilenameWidget | no-parent |  |  |  |
| IInputParameter | created | IProcess |  |  |
| IInputPasswordWidget | no-parent |  |  |  |
| IInputWidget | no-parent |  |  |  |
| IJavaScriptNode | not-allowed |  |  | InvalidOperationException: JavaScript objects can't be children of On Activity Close objec |
| IJoin | no-parent |  |  |  |
| IJSONDeserializeNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IJSONSerializeNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IKey | no-parent |  |  |  |
| ILabel | no-parent |  |  |  |
| ILink | no-parent |  |  |  |
| ILinkOnClick | no-parent |  |  |  |
| ILinkWidget | no-parent |  |  |  |
| IList | no-parent |  |  |  |
| IListItem | no-parent |  |  |  |
| IListItemAction | no-parent |  |  |  |
| IListRecordsWidget | no-parent |  |  |  |
| ILocalizedImage | no-parent |  |  |  |
| ILocalVariable | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Warning:UnusedElement |  |
| IMessageNode | not-allowed |  |  | InvalidOperationException: Message objects can't be children of On Activity Close objects |
| IMobileBlock | no-parent |  |  |  |
| IMobileBlockInstanceWidget | no-parent |  |  |  |
| IMobileFlow | not-allowed |  |  | InvalidOperationException: UI Flow objects can't be children of Module objects |
| IMobileScreen | no-parent |  |  |  |
| IMobileTheme | not-allowed |  |  | InvalidOperationException: Theme objects can't be children of Module objects |
| IMobileWidget | no-parent |  |  |  |
| INumericMetadata | skipped |  |  |  |
| IOnExceptionAction | no-parent |  |  |  |
| IOutputParameter | created | IProcess |  |  |
| IPlaceholderContentWidget | no-parent |  |  |  |
| IPlaceholderWidget | no-parent |  |  |  |
| IPopover | no-parent |  |  |  |
| IPopup | no-parent |  |  |  |
| IPreparation | no-parent |  |  |  |
| IProcess | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:ProcessMissingInboxDetail |  |
| IRadioButton | no-parent |  |  |  |
| IRadioButtonWidget | no-parent |  |  |  |
| IRadioGroup | no-parent |  |  |  |
| IRaiseExceptionNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In |  |
| IRecord | created | IStaticEntity |  |  |
| IRecordListToExcelNode | created-needs-config | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IRefreshDataNode | not-allowed |  |  | InvalidOperationException: Refresh Data objects can't be children of On Activity Close obj |
| IResource | created-with-messages | IESpace | Warning:UnusedResource |  |
| IRestAction | created-needs-config | IRestClient | Error:RequiredPropertyValue_Property |  |
| IRestActionInput | created-with-messages | IRestAction | Error:CustomObjectError |  |
| IRestActionOutput | created | IRestAction |  |  |
| IRestCallbackActionFlow | created | IRestClient |  |  |
| IRestClient | created-with-messages | IESpace | Error:CustomObjectError |  |
| IRestService | created-with-messages | IESpace | Error:CustomObjectError |  |
| IRestServiceAction | created | IRestService |  |  |
| IRestServiceActionInput | created-needs-config | IRestServiceAction | Warning:UnusedElement |  |
| IRestServiceActionOutput | created-needs-config | IRestServiceAction | Warning:UnusedElement |  |
| IRestServiceAuthenticationFlowInput | no-parent |  |  |  |
| IRestServiceCallbackActionFlowInput | no-parent |  |  |  |
| IRestServiceCallbackActionFlowOutput | no-parent |  |  |  |
| IRestStaticEntity | created | IRestClient |  |  |
| IRestStaticEntityAttribute | created-with-messages | IRestStaticEntity | Error:InvalidPropertyValue_Length |  |
| IRestStructure | created-with-messages | IRestClient | Error:InvalidStructure_NoAttr; Warning:UnusedCustomStructure |  |
| IRestStructureAttribute | created | IRestStructure |  |  |
| IRole | created | IESpace |  |  |
| IRowCell | no-parent |  |  |  |
| IRowWidget | no-parent |  |  |  |
| ISapAction | no-parent |  |  |  |
| ISapActionInput | no-parent |  |  |  |
| ISapActionOutput | no-parent |  |  |  |
| ISapCallbackActionFlowInput | no-parent |  |  |  |
| ISapClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing ServiceStudio.Plugin.SAP. |
| ISapStructure | no-parent |  |  |  |
| ISapStructureAttribute | no-parent |  |  |  |
| IScreen | no-parent |  |  |  |
| IScreenAction | no-parent |  |  |  |
| IScreenAggregate | no-parent |  |  |  |
| IScript | not-allowed |  |  | InvalidOperationException: Script objects can't be children of Module objects |
| ISendEmailNode | not-allowed |  |  | InvalidOperationException: Send Email objects can't be children of On Activity Close objec |
| IServerAction | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:UnusedUserAction |  |
| IServerEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IService | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IServiceAction | created-needs-config | IESpace | Error:InvalidFlow_NoStart |  |
| ISessionVariable | not-allowed |  |  | InvalidOperationException: Session Variable objects can't be children of Module objects |
| IShowRecordWidget | no-parent |  |  |  |
| ISiteProperty | created-needs-config | IESpace | Warning:UnusedElement |  |
| ISOAPAction | created | ISOAPClient |  |  |
| ISOAPActionInput | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPActionInputPolymorphic | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPActionInputWildcard | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPActionOutput | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPActionOutputPolymorphic | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPActionOutputWildcard | created-needs-config | ISOAPAction | Error:RequiredPropertyValue_Property |  |
| ISOAPClient | created | IESpace |  |  |
| ISOAPDynamicPasswordInput | created | ISOAPAction |  |  |
| ISOAPDynamicUsernameInput | created | ISOAPAction |  |  |
| ISOAPStaticEntity | created | ISOAPClient |  |  |
| ISOAPStaticEntityAttribute | created-with-messages | ISOAPStaticEntity | Error:InvalidPropertyValue_Length |  |
| ISOAPStaticEntityAttributePolymorphic | created-with-messages | ISOAPStaticEntityPolymorphic | Error:InvalidPropertyValue_Length; Error:InvalidPropertyValue_PropNoMore |  |
| ISOAPStaticEntityPolymorphic | created | ISOAPClient |  |  |
| ISOAPStructure | created-with-messages | ISOAPClient | Error:InvalidStructure_NoAttr; Warning:UnusedCustomStructure |  |
| ISOAPStructureAttribute | created-needs-config | ISOAPStructure | Error:RequiredPropertyValue_Property |  |
| ISOAPStructureAttributePolymorphic | created-needs-config | ISOAPStructurePolymorphic | Error:RequiredPropertyValue_Property |  |
| ISOAPStructurePolymorphic | created-with-messages | ISOAPClient | Error:InvalidStructure_NoAttr; Warning:UnusedCustomStructure |  |
| ISolution | no-parent |  |  |  |
| ISort | no-parent |  |  |  |
| ISQLInputParameter | created-needs-config | ISQLNode | Warning:UnusedElement |  |
| ISQLNode | created-with-messages | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidSQL_NoOutputStructure |  |
| ISQLOutput | needs-args |  |  | InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignatur |
| IStartNode | created-needs-config | ICallback, IProcess, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_Out |  |
| IStaticEntity | created-needs-config | IESpace | Error:InvalidEntity_StaticId |  |
| IStructure | created-needs-config | IESpace | Error:InvalidStructure_NoAttr; Warning:UnusedElement |  |
| IStructureAttribute | created | IStructure |  |  |
| ISwitch | no-parent |  |  |  |
| ISwitchCondition | created | ISwitchNode |  |  |
| ISwitchNode | created-with-messages | ICallback, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_In; Error:InvalidFlow_NoOtherwise |  |
| ISystemEvent | not-allowed |  |  | InvalidOperationException: IESpace 'Headless_CS' could not create OutSystems.Model.Logic.I |
| ITableRecords | no-parent |  |  |  |
| ITableRecordsWidget | no-parent |  |  |  |
| ITableWidget | no-parent |  |  |  |
| ITextArea | no-parent |  |  |  |
| ITextMetadata | skipped |  |  |  |
| ITextWidget | no-parent |  |  |  |
| ITimer | created-needs-config | IESpace | Error:RequiredPropertyValue_PropertyIn |  |
| ITriggerNode | not-allowed |  |  | InvalidOperationException: Trigger Event objects can't be children of On Activity Close ob |
| IUIFlow | not-allowed |  |  | InvalidOperationException: UI flows are not supported by Service eSpaces |
| IUpload | no-parent |  |  |  |
| IUserException | created | IESpace |  |  |
| IWaitNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IWebBlock | no-parent |  |  |  |
| IWebBlockInstanceWidget | no-parent |  |  |  |
| IWebEmail | no-parent |  |  |  |
| IWebFlow | not-allowed |  |  | InvalidOperationException: UI Flow objects can't be children of Module objects |
| IWebScreen | no-parent |  |  |  |
| IWebTheme | not-allowed |  |  | InvalidOperationException: Theme objects can't be children of Module objects |
| IWebWidget | no-parent |  |  |  |
| Void | skipped |  |  |  |

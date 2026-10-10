# Mapa de capacidades, coluna criar: traditional-ui (gerado 2026-09-05T00:09:17)

Tipos por melhor estado: no-parent=57, created-needs-config=56, created=54, not-allowed=18, created-with-messages=18, skipped=6, needs-args=4, failed=1.

Pares: no-parent=947, skipped=328, created-needs-config=304, not-allowed=214, created=153, created-with-messages=99, failed=97, needs-args=5.

| Tipo | Melhor estado | Pais que criam | Mensagens (amostra) | Erro (amostra) |
|---|---|---|---|---|
| IAction | no-parent |  |  |  |
| IActivityOutputParameter | created | IAutomaticActivityNode, IConditionalStartNode, IHumanActivityNode, IWaitNode |  |  |
| IAddSourceOperation | no-parent |  |  |  |
| IAdvancedHtml | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IAggregateAttribute | no-parent |  |  |  |
| IAggregateNode | created-with-messages | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidDataSet_NoEntity |  |
| IAjaxRefreshNode | created-needs-config | IScreenAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Ajax Refresh objects can't be children of On Activity Close obj |
| IAliasedSource | no-parent |  |  |  |
| IApplication | no-parent |  |  |  |
| IAssignment | created-with-messages | IAssignNode | Error:InvalidVariable_UnknownVarIn; Error:ExpressionRequiredExpression |  |
| IAssignNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IAttachFileNode | not-allowed |  |  | InvalidOperationException: Attach File objects can't be children of On Activity Close obje |
| IAutomaticActivityNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IBinaryMetadata | skipped |  |  |  |
| IBlock | created | IUIFlow |  |  |
| IBlockEvent | created | IBlock |  |  |
| IBooleanMetadata | skipped |  |  |  |
| IButton | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IButtonGroup | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IButtonGroupItem | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IButtonWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_Property | InvalidOperationException: Button objects can't be children of Email objects |
| ICalculatedAttribute | no-parent |  |  |  |
| ICallback | created-needs-config | IConditionalStartNode, IHumanActivityNode, IWaitNode | Error:InvalidFlow_NoStart | ArgumentException: An item with the same key has already been added. Key: rIl9YOPFuUyhFvQj |
| ICellWidget | created | IRowWidget |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ICheckbox | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ICheckBoxWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Check Box objects can't be children of Email objects |
| IClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IClientAction | not-allowed |  |  | InvalidOperationException: Client Action objects can't be children of Module objects |
| IClientEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IClientVariable | not-allowed |  |  | InvalidOperationException: Client Variable objects can't be children of Module objects |
| ICombineSourcesOperation | no-parent |  |  |  |
| IComboBoxWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:InvalidPropertySelection_SelRequires | InvalidOperationException: Combo Box objects can't be children of Email objects |
| IComment | created | IWebFlow |  |  |
| ICommentConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IActionNode) |
| ICommentNode | created | ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction |  |  |
| IConditionalStartNode | created-needs-config | IProcess | Error:RequiredConnector_Out |  |
| IContainer | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IContainerWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget |  | InvalidOperationException: Container objects can't be children of Email objects |
| IDataAction | no-parent |  |  |  |
| IDateTimeMetadata | skipped |  |  |  |
| IDecisionConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode) |
| IDecisionNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IDecisionOutcomeNode | created-needs-config | IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Decision Outcome objects can't be children of On Activity Close |
| IDestinationNode | created-needs-config | IOnExceptionAction, IPreparation, IScreenAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Destination objects can't be children of On Activity Close obje |
| IDownloadNode | created-needs-config | IPreparation, IScreenAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Nodes of type IDownloadNode are not allowed in ICallback or eSp |
| IDropdown | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IEditableTable | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Warning:CustomObjectWarning; Error:RequiredPropertyValue_Property | InvalidOperationException: CustomWidget objects can't be children of Email objects |
| IEditableTableCell | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget |  | InvalidOperationException: CustomWidget objects can't be children of Email objects |
| IEditRecordWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, IContainerWidget, IIfBranchWidget | Error:RequiredPropertyValue_PropertyIn; Warning:MissingWidgetContent | InvalidOperationException: Edit Record objects can't be children of Email objects |
| IEmail | created-needs-config | IUIFlow | Error:RequiredPropertyValue_PropertyIn |  |
| IEndNode | created-needs-config | ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IPreparation, IScreenAction | Error:RequiredConnector_In | NullReferenceException: Object reference not set to an instance of an object. |
| IEntity | no-parent |  |  |  |
| IEntityAttribute | created | IEntity |  |  |
| IEntry | created-needs-config | IWebFlow | Error:RequiredConnector_Out |  |
| IESpace | no-parent |  |  |  |
| IEvent | no-parent |  |  |  |
| IExcelToRecordListNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExceptionHandlerNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out |  |
| IExecuteClientActionNode | not-allowed |  |  | InvalidOperationException: Run Client Action objects can't be children of On Activity Clos |
| IExecuteProcessNode | created-needs-config | IProcess | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExecuteServerActionNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExpression | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IExpressionWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen | Error:RequiredPropertyValue_PropertyIn |  |
| IExtendedProperty | created-needs-config | IWebEmail, IWebScreen, IButtonWidget, ICellWidget, ICheckBoxWidget, IContainerWidget | Error:RequiredPropertyValue_Property |  |
| IExtension | no-parent |  |  |  |
| IExtensionResource | no-parent |  |  |  |
| IExternalSite | created | IWebFlow |  |  |
| IFilter | no-parent |  |  |  |
| IFolder | created | IESpace |  |  |
| IForEachNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IForm | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_Property | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IGoToDestination | created-needs-config | IWebFlow | Error:RequiredPropertyValue_PropertyIn |  |
| IGroupByAttribute | no-parent |  |  |  |
| IGroupByOperation | no-parent |  |  |  |
| IHeaderCell | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IHumanActivityNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IIcon | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IIfBranchWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IIfNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IIfWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen | Error:RequiredPropertyValue_PropertyIn | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IImage | no-parent |  |  | InvalidOperationException: Image binary cannot be null: Object not set |
| IInput | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IInputFilenameWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget |  | InvalidOperationException: Upload objects can't be children of Email objects |
| IInputParameter | created | ISystemEvent, IProcess, IBlock, IBlockEvent, IEmail, IScreen | Warning:UnusedElement |  |
| IInputPasswordWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Input Password objects can't be children of Email objects |
| IInputWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Input objects can't be children of Email objects |
| IJavaScriptNode | not-allowed |  |  | InvalidOperationException: JavaScript objects can't be children of On Activity Close objec |
| IJoin | no-parent |  |  |  |
| IJSONDeserializeNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IJSONSerializeNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IKey | no-parent |  |  |  |
| ILabel | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ILink | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ILinkOnClick | failed |  |  | ArgumentException: An item with the same key has already been added. Key: Xl7+p_MigESpGpch |
| ILinkWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_Property | InvalidOperationException: Link objects can't be children of Email objects |
| IList | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IListItem | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IListItemAction | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IListRecordsWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen | Error:RequiredPropertyValue_PropertyIn; Warning:MissingWidgetContent | InvalidOperationException: List Records objects can't be children of Cell objects |
| ILocalizedImage | needs-args |  |  | InvalidOperationException: CreateLocalizedImage needs arg 'locale' (ILocale) |
| ILocalVariable | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IBlock, IEmail | Warning:UnusedElement |  |
| IMessageNode | not-allowed |  |  | InvalidOperationException: Message objects can't be children of On Activity Close objects |
| IMobileBlock | no-parent |  |  |  |
| IMobileBlockInstanceWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IMobileFlow | not-allowed |  |  | InvalidOperationException: UI Flow objects can't be children of Module objects |
| IMobileScreen | no-parent |  |  |  |
| IMobileTheme | not-allowed |  |  | InvalidOperationException: Theme objects can't be children of Module objects |
| IMobileWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| INumericMetadata | skipped |  |  |  |
| IOnExceptionAction | created-with-messages | IUIFlow | Error:EmptyOnExceptionHandler |  |
| IOutputParameter | created | ISystemEvent, IProcess, IScreenAction | Warning:UnusedElement |  |
| IPlaceholderContentWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IPlaceholderWidget | created | IBlock, IWebBlock, ICellWidget, IContainerWidget, IIfBranchWidget, IEditableTableCell |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IPopover | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IPopup | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IPreparation | created-needs-config | IWebEmail, IWebScreen | Error:InvalidFlow_NoStart | ArgumentException: An item with the same key has already been added. Key: _5sqIAe8Z0mLMNBs |
| IProcess | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:ProcessMissingInboxDetail |  |
| IRadioButton | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IRadioButtonWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Radio Button objects can't be children of Email objects |
| IRadioGroup | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IRaiseExceptionNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In |  |
| IRecord | created-needs-config | IStaticEntity | Error:RequiredPropertyValue_Property |  |
| IRecordListToExcelNode | created-needs-config | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IRefreshDataNode | created-needs-config | IScreenAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Refresh Data objects can't be children of On Activity Close obj |
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
| IRowCell | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IRowWidget | created | IEditRecordWidget, IShowRecordWidget, ITableWidget |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ISapAction | no-parent |  |  |  |
| ISapActionInput | no-parent |  |  |  |
| ISapActionOutput | no-parent |  |  |  |
| ISapCallbackActionFlowInput | no-parent |  |  |  |
| ISapClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing ServiceStudio.Plugin.SAP. |
| ISapStructure | no-parent |  |  |  |
| ISapStructureAttribute | no-parent |  |  |  |
| IScreen | created-with-messages | IUIFlow | Error:EventHandlerRequiredAction |  |
| IScreenAction | created-with-messages | IWebBlock, IWebScreen | Error:InvalidFlow_NoStart; Warning:UnusedAction |  |
| IScreenAggregate | no-parent |  |  |  |
| IScript | not-allowed |  |  | InvalidOperationException: Script objects can't be children of Module objects |
| ISendEmailNode | created-needs-config | ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IServerAction | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:UnusedUserAction |  |
| IServerEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IService | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IServiceAction | not-allowed |  |  | InvalidOperationException: Service Action objects can't be children of Module objects |
| ISessionVariable | created-needs-config | IESpace | Warning:UnusedElement |  |
| IShowRecordWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen | Error:RequiredPropertyValue_PropertyIn; Warning:MissingWidgetContent | InvalidOperationException: Show Record objects can't be children of Cell objects |
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
| ISQLNode | created-with-messages | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidSQL_NoOutputStructure |  |
| ISQLOutput | needs-args |  |  | InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignatur |
| IStartNode | created-needs-config | ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IDecisionNode, IPreparation | Error:RequiredConnector_Out | InvalidOperationException: Start objects can't be children of On Exception Action objects |
| IStaticEntity | created-needs-config | IESpace | Error:InvalidEntity_StaticId |  |
| IStructure | created-needs-config | IESpace | Error:InvalidStructure_NoAttr; Warning:UnusedElement |  |
| IStructureAttribute | created | IStructure |  |  |
| ISwitch | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ISwitchCondition | created | ISwitchNode |  |  |
| ISwitchNode | created-with-messages | ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction, IPreparation | Error:RequiredConnector_In; Error:InvalidFlow_NoOtherwise |  |
| ISystemEvent | created-needs-config | IESpace | Error:InvalidFlow_NoStart |  |
| ITableRecords | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ITableRecordsWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen | Error:RequiredPropertyValue_PropertyIn; Warning:MissingWidgetContent | InvalidOperationException: Table Records objects can't be children of Cell objects |
| ITableWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen |  | InvalidOperationException: Table objects can't be children of Link objects |
| ITextArea | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ITextMetadata | skipped |  |  |  |
| ITextWidget | created | IBlock, IEmail, IScreen, IWebBlock, IWebEmail, IWebScreen |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| ITimer | created-needs-config | IESpace | Error:RequiredPropertyValue_PropertyIn |  |
| ITriggerNode | created-needs-config | IScreenAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Trigger Event objects can't be children of On Activity Close ob |
| IUIFlow | created | IESpace |  |  |
| IUpload | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IUserException | created | IESpace |  |  |
| IWaitNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IWebBlock | created | IWebFlow |  |  |
| IWebBlockInstanceWidget | created | IBlock, IScreen, IWebBlock, IWebScreen, ICellWidget, IContainerWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Web Block objects can't be children of Email objects |
| IWebEmail | created-needs-config | IWebFlow | Error:RequiredPropertyValue_PropertyIn |  |
| IWebFlow | created | IESpace |  |  |
| IWebScreen | created-with-messages | IWebFlow | Error:EventHandlerRequiredAction |  |
| IWebTheme | created | IESpace |  |  |
| IWebWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| Void | skipped |  |  |  |

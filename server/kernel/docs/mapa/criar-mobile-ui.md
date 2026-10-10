# Mapa de capacidades, coluna criar: mobile-ui (gerado 2026-09-05T00:09:05)

Tipos por melhor estado: created=63, created-needs-config=50, no-parent=38, not-allowed=34, created-with-messages=19, skipped=6, needs-args=4.

Pares: created-needs-config=609, no-parent=550, skipped=328, created=271, not-allowed=226, created-with-messages=131, failed=27, needs-args=5.

| Tipo | Melhor estado | Pais que criam | Mensagens (amostra) | Erro (amostra) |
|---|---|---|---|---|
| IAction | no-parent |  |  |  |
| IActivityOutputParameter | created | IAutomaticActivityNode, IConditionalStartNode, IHumanActivityNode, IWaitNode |  |  |
| IAddSourceOperation | no-parent |  |  |  |
| IAdvancedHtml | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IAggregateAttribute | no-parent |  |  |  |
| IAggregateNode | created-with-messages | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidDataSet_NoEntity |  |
| IAjaxRefreshNode | not-allowed |  |  | InvalidOperationException: Ajax Refresh objects can't be children of Server Action objects |
| IAliasedSource | no-parent |  |  |  |
| IApplication | no-parent |  |  |  |
| IAssignment | created-with-messages | IAssignNode | Error:InvalidVariable_UnknownVarIn; Error:ExpressionRequiredExpression |  |
| IAssignNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IAttachFileNode | not-allowed |  |  | InvalidOperationException: Attach File objects can't be children of Server Action objects |
| IAutomaticActivityNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IBinaryMetadata | skipped |  |  |  |
| IBlock | created | IUIFlow |  |  |
| IBlockEvent | created | IBlock |  |  |
| IBooleanMetadata | skipped |  |  |  |
| IButton | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IButtonGroup | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IButtonGroupItem | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IButtonWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ICalculatedAttribute | no-parent |  |  |  |
| ICallback | created-needs-config | IConditionalStartNode, IHumanActivityNode, IWaitNode | Error:InvalidFlow_NoStart | ArgumentException: An item with the same key has already been added. Key: hVrSLUHi70GFGZad |
| ICellWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ICheckbox | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| ICheckBoxWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IClientAction | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:UnusedUserAction |  |
| IClientEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IClientVariable | created-needs-config | IESpace | Warning:UnusedElement |  |
| ICombineSourcesOperation | no-parent |  |  |  |
| IComboBoxWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IComment | created | IMobileFlow |  |  |
| ICommentConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IActionNode) |
| ICommentNode | created | IAction, ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IDecisionNode |  |  |
| IConditionalStartNode | created-needs-config | IProcess | Error:RequiredConnector_Out |  |
| IContainer | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IContainerWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IDataAction | created-with-messages | IMobileBlock, IMobileScreen | Error:InvalidFlow_NoStart; Warning:UnusedAction; Error:InvalidDataAction_OutputMustBeSet |  |
| IDateTimeMetadata | skipped |  |  |  |
| IDecisionConnector | needs-args |  |  | InvalidOperationException: CreateConnector needs arg 'target' (IProcessNode) |
| IDecisionNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IDecisionOutcomeNode | created-needs-config | IDecisionNode | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Decision Outcome objects can't be children of Server Action obj |
| IDestinationNode | created-needs-config | IOnExceptionAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In | InvalidOperationException: Destination objects can't be children of Server Action objects |
| IDownloadNode | no-parent |  |  | InvalidOperationException: Nodes of type IDownloadNode are not allowed in IServerAction or |
| IDropdown | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property; Error:InvalidPropertyValue_Units |  |
| IEditableTable | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IEditableTableCell | no-parent |  |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IEditRecordWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IEmail | created-needs-config | IUIFlow | Error:RequiredPropertyValue_PropertyIn |  |
| IEndNode | created-needs-config | IAction, ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IOnExceptionAction | Error:RequiredConnector_In | NullReferenceException: Object reference not set to an instance of an object. |
| IEntity | no-parent |  |  |  |
| IEntityAttribute | no-parent |  |  |  |
| IEntry | no-parent |  |  |  |
| IESpace | no-parent |  |  |  |
| IEvent | created-needs-config | IPlaceholderWidget, IAdvancedHtml, IButton, IButtonGroup, IButtonGroupItem, ICheckbox | Error:RequiredPropertyValue_Property |  |
| IExcelToRecordListNode | created-needs-config | IAction, ICallback, IAutomaticActivityNode, IDecisionNode, IDataAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Excel To Record List objects can't be children of On Applicatio |
| IExceptionHandlerNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out |  |
| IExecuteClientActionNode | created-needs-config | ISystemEvent, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Run Client Action objects can't be children of Server Action ob |
| IExecuteProcessNode | created-needs-config | IProcess | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExecuteServerActionNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IExpression | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IExpressionWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IExtendedProperty | created-needs-config | IPlaceholderWidget, ITextWidget, IAdvancedHtml, IButton, IButtonGroup, IButtonGroupItem | Error:RequiredPropertyValue_Property |  |
| IExtension | no-parent |  |  |  |
| IExtensionResource | no-parent |  |  |  |
| IExternalSite | created | IMobileFlow |  |  |
| IFilter | no-parent |  |  |  |
| IFolder | created | IESpace |  |  |
| IForEachNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IForm | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Warning:MissingWidgetContent | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| IGoToDestination | no-parent |  |  |  |
| IGroupByAttribute | no-parent |  |  |  |
| IGroupByOperation | no-parent |  |  |  |
| IHeaderCell | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IHumanActivityNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IIcon | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IIfBranchWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IIfNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IIfWidget | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_PropertyIn | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IImage | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:InvalidPropertyValue_Units | InvalidOperationException: Image binary cannot be null: Object not set |
| IInput | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IInputFilenameWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IInputParameter | created | IAction, ISystemEvent, IJavaScriptNode, IProcess, IBlock, IBlockEvent | Warning:UnusedElement |  |
| IInputPasswordWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IInputWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IJavaScriptNode | created-with-messages | ISystemEvent, IOnExceptionAction | Error:RequiredConnector_Out; Error:RequiredConnector_In; Warning:JavascriptNode_EmptyJs | InvalidOperationException: JavaScript objects can't be children of Server Action objects |
| IJoin | no-parent |  |  |  |
| IJSONDeserializeNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IJSONSerializeNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IKey | no-parent |  |  |  |
| ILabel | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  | InvalidCastException: Unable to cast object of type 'WebBlock' to type 'ServiceStudio.Mode |
| ILink | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| ILinkOnClick | no-parent |  |  |  |
| ILinkWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IList | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IListItem | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IListItemAction | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IListRecordsWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ILocalizedImage | needs-args |  |  | InvalidOperationException: CreateLocalizedImage needs arg 'locale' (ILocale) |
| ILocalVariable | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IBlock | Warning:UnusedElement |  |
| IMessageNode | created-needs-config | ISystemEvent, IOnExceptionAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Message objects can't be children of Server Action objects |
| IMobileBlock | created | IMobileFlow |  |  |
| IMobileBlockInstanceWidget | created | IBlock, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget, IPlaceholderContentWidget | Error:RequiredPropertyValue_PropertyIn | InvalidOperationException: Block objects can't be children of Email objects |
| IMobileFlow | created | IESpace |  |  |
| IMobileScreen | created | IMobileFlow |  |  |
| IMobileTheme | created | IESpace |  |  |
| IMobileWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| INumericMetadata | skipped |  |  |  |
| IOnExceptionAction | created-with-messages | IUIFlow | Error:EmptyOnExceptionHandler |  |
| IOutputParameter | created | IAction, ISystemEvent, IJavaScriptNode, IProcess, IDataAction | Warning:UnusedElement |  |
| IPlaceholderContentWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Mobil |
| IPlaceholderWidget | created | IBlock, IMobileBlock, IIfBranchWidget, IButtonGroupItem, IContainer, ILink |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IPopover | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IPopup | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IPreparation | no-parent |  |  |  |
| IProcess | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:ProcessMissingInboxDetail |  |
| IRadioButton | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IRadioButtonWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IRadioGroup | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| IRaiseExceptionNode | created-needs-config | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredPropertyValue_Property; Error:RequiredConnector_In |  |
| IRecord | created | IStaticEntity |  |  |
| IRecordListToExcelNode | created-needs-config | IAction, ICallback, IAutomaticActivityNode, IDecisionNode, IDataAction | Error:RequiredPropertyValue_PropertyIn; Error:RequiredConnector_Out; Error:RequiredConnector_In | InvalidOperationException: Record List To Excel objects can't be children of On Applicatio |
| IRefreshDataNode | not-allowed |  |  | InvalidOperationException: Refresh Data objects can't be children of Server Action objects |
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
| IRowCell | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  |  |
| IRowWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ISapAction | no-parent |  |  |  |
| ISapActionInput | no-parent |  |  |  |
| ISapActionOutput | no-parent |  |  |  |
| ISapCallbackActionFlowInput | no-parent |  |  |  |
| ISapClient | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing ServiceStudio.Plugin.SAP. |
| ISapStructure | no-parent |  |  |  |
| ISapStructureAttribute | no-parent |  |  |  |
| IScreen | created | IUIFlow |  |  |
| IScreenAction | created-with-messages | IMobileBlock, IMobileScreen | Error:InvalidFlow_NoStart; Warning:UnusedAction |  |
| IScreenAggregate | created-with-messages | IMobileBlock, IMobileScreen | Error:InvalidDataSet_NoEntity; Warning:UnusedScreenData; Warning:SplashScreen_ServerInteraction |  |
| IScript | created | IESpace |  |  |
| ISendEmailNode | not-allowed |  |  | InvalidOperationException: Send Email objects can't be children of Server Action objects |
| IServerAction | created-needs-config | IESpace | Error:InvalidFlow_NoStart; Warning:UnusedUserAction |  |
| IServerEntity | created-needs-config | IESpace | Error:InvalidEntity_OneAttr |  |
| IService | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.In |
| IServiceAction | not-allowed |  |  | InvalidOperationException: Service Action objects can't be children of Module objects |
| ISessionVariable | not-allowed |  |  | InvalidOperationException: Session Variable objects can't be children of Module objects |
| IShowRecordWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
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
| ISQLNode | created-with-messages | IAction, ICallback, IAutomaticActivityNode, IDecisionNode, IDataAction | Error:RequiredConnector_Out; Error:RequiredConnector_In; Error:InvalidSQL_NoOutputStructure | InvalidOperationException: SQL objects can't be children of On Application Ready objects |
| ISQLOutput | needs-args |  |  | InvalidOperationException: CreateOutput needs arg 'entityOrStructure' (IRecordTypeSignatur |
| IStartNode | created-needs-config | IAction, ICallback, ISystemEvent, IProcess, IAutomaticActivityNode, IDecisionNode | Error:RequiredConnector_Out | InvalidOperationException: Start objects can't be children of On Exception Action objects |
| IStaticEntity | created-needs-config | IESpace | Error:InvalidEntity_StaticId |  |
| IStructure | created-needs-config | IESpace | Error:InvalidStructure_NoAttr; Warning:UnusedElement |  |
| IStructureAttribute | created | IStructure |  |  |
| ISwitch | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| ISwitchCondition | created | ISwitchNode |  |  |
| ISwitchNode | created-with-messages | IAction, ICallback, ISystemEvent, IAutomaticActivityNode, IDecisionNode, IOnExceptionAction | Error:RequiredConnector_In; Error:InvalidFlow_NoOtherwise |  |
| ISystemEvent | created-needs-config | IESpace | Error:InvalidFlow_NoStart |  |
| ITableRecords | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| ITableRecordsWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ITableWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ITextArea | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:RequiredPropertyValue_Property |  |
| ITextMetadata | skipped |  |  |  |
| ITextWidget | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| ITimer | created-needs-config | IESpace | Error:RequiredPropertyValue_PropertyIn |  |
| ITriggerNode | not-allowed |  |  | InvalidOperationException: Trigger Event objects can't be children of Server Action object |
| IUIFlow | created | IESpace |  |  |
| IUpload | created | IBlock, IEmail, IScreen, IMobileBlock, IMobileScreen, IIfBranchWidget | Error:InvalidPropertyValue_Units; Error:RequiredPropertyValue_Property |  |
| IUserException | created | IESpace |  |  |
| IWaitNode | created-needs-config | IProcess | Error:RequiredConnector_Out; Error:RequiredConnector_In |  |
| IWebBlock | no-parent |  |  |  |
| IWebBlockInstanceWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| IWebEmail | no-parent |  |  |  |
| IWebFlow | not-allowed |  |  | InvalidOperationException: UI Flow objects can't be children of Module objects |
| IWebScreen | no-parent |  |  |  |
| IWebTheme | not-allowed |  |  | InvalidOperationException: Theme objects can't be children of Module objects |
| IWebWidget | not-allowed |  |  | ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.UI.Web.W |
| Void | skipped |  |  |  |

# OutSystems.Model.V1 (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## OutSystems.Model

### enum Border
- NotDefined
- None
- Soft
- Rounded

### class Configuration
- bool AllowGlobalEventsInServiceModules { get; set; }
- bool AllowUserDefinedFunctionInAggregates { get; set; }
- bool AppGenMode { get; set; }
- bool CalculateExtensionDigestOnDemand { get; set; }
- bool CreateESpaceDefaultsToODC { get; set; }
- PlatformServerVersion DefaultPlatformServerVersion { get; set; }
- string DeveloperId { get; set; }
- bool EnablePropertySetterDescriptorValidation { get; set; }
- IDictionary<string, bool> FeatureToggles { get; set; }
- IDictionary<Guid, ModelFeatureToggle> ModelFeatureStatus { get; set; }
- FileStorageStrategy StorageStrategy { get; set; }
- bool UseCustomHashingAlgorithm { get; set; }
- bool UseModelVersioning { get; set; }
- bool UseOptimizedGetAllDescendantsOfType { get; set; }
- bool UseOptimizedUpgrade { get; set; }
- bool UseSharedCache { get; set; }

### class ConfigurationDefaults

### static class DefaultValues

### static class ESpaceServicesExtensions
- string Encode(IESpace eSpace, XRayEncoding.EncodingConfig config = null)
- PlatformServerVersion GetPlatformServerVersion(IESpace eSpace)

### class ExtensionConstants

### enum FileStorageStrategy
- InMemory
- Temp
- ApplicationData

### enum FontFamily
- NotDefined
- SystemFont
- OpenSans
- Roboto
- Lato
- PTSerif
- Ubuntu

### interface IAbstractionsManager : IObject
- IAbstractionsManagerDescriptor Descriptor { get; }
- ISet<IClassDescriptor> DescriptorsOfObjectsModifiedAfterHeal { get; }
- string DigestAfterHeal { get; }
- Action<IAbstractionsManager> Heal
- void OnHealCompleted()

### interface IAbstractionsManagerDescriptor : IObjectDescriptor
- IProperty DigestAfterHealProperty { get; }

### interface IAIArgument : IObject
- ITypeSignature ConcreteParameterType { get; }
- string Description { get; set; }
- IAIArgumentDescriptor Descriptor { get; }
- bool IsFilledByAI { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IInputParameterSignature Parameter { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IAIArgumentDescriptor : IObjectDescriptor
- IProperty ConcreteParameterTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsFilledByAIProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty ParameterProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IArgument : IArgumentSignature, IObject
- ITypeSignature ConcreteParameterType { get; }
- IArgumentDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IArgumentDescriptor : IArgumentSignatureDescriptor, IObjectDescriptor
- IProperty ConcreteParameterTypeProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IArgumentSignature : IObjectSignature
- IArgumentSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IInputParameterSignature Parameter { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IArgumentSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty ParameterProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface IBinaryMetadata : IMetadata
- IBinaryMetadataDescriptor Descriptor { get; }
- Byte[] Value { get; set; }

### interface IBinaryMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface IBooleanMetadata : IMetadata
- IBooleanMetadataDescriptor Descriptor { get; }
- bool Value { get; set; }

### interface IBooleanMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface IConnector : IObject
- IConnectorDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IFlowNode Source { get; }
- IFlowNode Target { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IConnectorDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty TargetProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IDateTimeMetadata : IMetadata
- IDateTimeMetadataDescriptor Descriptor { get; }
- DateTime Value { get; set; }

### interface IDateTimeMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface IDependency
- IEnumerable<IDependency> Dependencies { get; }
- IKey Key { get; }
- string Name { get; }
- string Revision { get; }
- SegmentationKind SegmentationKind { get; }
- string SignatureDigest { get; }
- string VersionDigest { get; }

### interface IDependencyGraph
- IEnumerable<IDependency> Dependencies { get; }
- IDependencyGraph GetGraphWithoutConflicts()

### interface IESpace : IModule, IObject, IOMLComponent
- ISystemException AbortActivityChangeException { get; }
- IAbstractionsManager AbstractionsManager { get; }
- IAgentManifest AgentManifest { get; }
- IEnumerable<IAgent> Agents { get; }
- ISystemException AllExceptions { get; }
- IRoleSignature AnonymousRole { get; }
- IEnumerable<IAnonymousStructure> AnonymousStructures { get; }
- IEnumerable<IBasicType> BasicTypes { get; }
- IBasicType BinaryDataType { get; }
- IBasicType BooleanType { get; }
- IBuiltinFunctions BuiltinFunctions { get; }
- IEnumerable<IBusinessProcess> BusinessProcesses { get; }
- IEnumerable<IClientAction> ClientActions { get; }
- IEnumerable<IClientVariable> ClientVariables { get; }
- IKey ClonedFromKey { get; }
- ISystemException CommunicationException { get; }
- Guid ContentDigest { get; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- IBasicType CurrencyType { get; }
- ISystemException DatabaseException { get; }
- IBasicType DateTimeType { get; }
- IBasicType DateType { get; }
- DBMSType DBMS { get; set; }
- IBasicType DecimalType { get; }
- IMobileThemeSignature DefaultMobileTheme { get; set; }
- IUIFlowNodeSignature DefaultScreen { get; set; }
- TransitionType DefaultTransition { get; set; }
- IWebThemeSignature DefaultWebTheme { get; set; }
- IEnumerable<IReference> Dependencies { get; }
- IDependencyGraph DependencyGraph { get; }
- IESpaceDescriptor Descriptor { get; }
- string Digest { get; }
- Guid DigestForLibrariesVersioning { get; }
- IBasicType EmailType { get; }
- IEnumerable<IEntity> Entities { get; }
- IEnumerable<IEntityDiagram> EntityDiagrams { get; }
- ITextWithReferencedElements ExtensibilityConfigurations { get; }
- IEnumerable<IExtensibilitySetting> ExtensibilitySettings { get; }
- IBasicType FileType { get; }
- IEnumerable<IFolder> Folders { get; }
- IGenericType GenericListType { get; }
- IGenericType GenericRecordType { get; }
- IEnumerable<IGlobalEventHandler> GlobalEventHandlers { get; }
- IEnumerable<IGlobalEvent> GlobalEvents { get; }
- IOnExceptionAction GlobalExceptionHandler { get; set; }
- bool HideWidgetsDistributedWithIDE { get; set; }
- Byte[] Icon { get; set; }
- IEnumerable<IImage> Images { get; }
- IBasicType IntegerIdentifierType { get; }
- IBasicType IntegerType { get; }
- IEnumerable<IIntegration> Integrations { get; }
- string InvalidCurrency { get; set; }
- string InvalidDate { get; set; }
- string InvalidDateTime { get; set; }
- string InvalidDecimal { get; set; }
- string InvalidEmail { get; set; }
- string InvalidInteger { get; set; }
- ISystemException InvalidLoginException { get; }
- string InvalidNumericPassword { get; set; }
- string InvalidPhone { get; set; }
- string InvalidText { get; set; }
- string InvalidTime { get; set; }
- string InvisibleStyleSheet { get; }
- bool IsInIsolated { get; set; }
- bool IsInMigrationsMergeModulesProcess { get; set; }
- bool IsMultiTenant { get; set; }
- bool IsTemplateBundle { get; set; }
- bool IsUserProvider { get; set; }
- string JavaScript { get; set; }
- JQueryVersion JQueryVersion { get; set; }
- SegmentationKind Kind { get; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- Version LastUpgradeVersion { get; }
- IEnumerable<IListType> ListTypes { get; }
- IEnumerable<ILocale> Locales { get; }
- IBasicType LongIntegerIdentifierType { get; }
- IBasicType LongIntegerType { get; }
- string MandatoryInput { get; set; }
- ISequence<IMetadata> Metadata { get; }
- Guid MigrationProcessKey { get; }
- IMobileConfigurations MobileConfigurations { get; }
- IEnumerable<IMobileFlow> MobileFlows { get; }
- IMobileFrameworksConfiguration MobileFrameworksConfiguration { get; }
- IEnumerable<IMobileTheme> MobileThemes { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- ISystemException NotRegisteredException { get; }
- IType ObjectType { get; }
- ISystemEvent OnApplicationReady { get; }
- ISystemEvent OnApplicationResume { get; }
- ISystemEvent OnBeginWebRequest { get; }
- ISystemEvent OnSessionStart { get; }
- ISystemEvent OnSync { get; }
- IBasicType PhoneNumberType { get; }
- IPreviousScreen PreviousScreen { get; }
- IEnumerable<IProcess> Processes { get; }
- bool ReadOnlyMode { get; }
- IEnumerable<IReference> References { get; }
- IRoleSignature RegisteredRole { get; }
- IEnumerable<IRequiredModelPlugin> RequiredModelPlugins { get; }
- ICollection<IScriptSignature> RequiredScripts { get; }
- IEnumerable<IResource> Resources { get; }
- int? RetryInterval { get; set; }
- bool RetrySynchronizations { get; set; }
- IEnumerable<IRoleException> RoleExceptions { get; }
- IEnumerable<IAppRole> Roles { get; }
- IEnumerable<IScript> Scripts { get; }
- ISystemException SecurityException { get; }
- IEnumerable<IServerAction> ServerActions { get; }
- int? ServerRequestTimeout { get; set; }
- IEnumerable<IServiceAction> ServiceActions { get; }
- IEnumerable<ISessionVariable> SessionVariables { get; }
- Guid SignatureCompatibilityDigest { get; }
- IEnumerable<ISiteProperty> SiteProperties { get; }
- bool SkipDependencyValidation { get; set; }
- bool SkipESpaceValidation { get; set; }
- IEnumerable<ISOAPClient> SOAPClients { get; }
- IEnumerable<ISOAPService> SOAPServices { get; }
- IUIFlowNodeSignature SplashScreen { get; set; }
- IEnumerable<IStructure> Structures { get; }
- bool SynchronizeOnOnline { get; set; }
- bool SynchronizeOnResume { get; set; }
- IEnumerable<ISystemException> SystemExceptions { get; }
- IEnumerable<IRoleSignature> SystemRoles { get; }
- IEnumerable<IStaticEntitySignature> SystemStaticEntities { get; }
- IEnumerable<IStructureSignature> SystemStructures { get; }
- IBasicType TextIdentifierType { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IBasicType TextType { get; }
- IEnumerable<ITimer> Timers { get; }
- IBasicType TimeType { get; }
- IType UnknownListType { get; }
- IType UnknownRecordType { get; }
- string UpgradeComplete { get; set; }
- string UpgradeFailed { get; set; }
- string UpgradeFailedOnDataModel { get; set; }
- string UpgradeFailedOnResources { get; set; }
- string UpgradeRequired { get; set; }
- string UpgradeRequiredWithDataLoss { get; set; }
- bool UseCookies { get; set; }
- bool UseDefaultThemeExceptionHandler { get; set; }
- ISystemException UserException { get; }
- IEnumerable<IUserException> UserExceptions { get; }
- bool UsesCache { get; }
- IEnumerable<IESpaceVersion> Versions { get; }
- IEnumerable<IWebFlow> WebFlows { get; }
- WebScreenRenderingMode WebScreenRenderingMode { get; set; }
- string WebServicesNamespace { get; set; }
- IEnumerable<IWebTheme> WebThemes { get; }
- IEnumerable<IObjectSignature> AddDependencies(IEnumerable<IGlobalKey> elements, bool fixSpecificVersion = False)
- IObjectSignature AddDependency(IESpace sourceESpace)
- SignatureT AddDependency<ConcreteT, SignatureT>(IShareableModelPluginObject<ConcreteT, SignatureT> sourceObj)
- SignatureT AddDependency<ConcreteT, SignatureT>(IShareableObjectSignature<ConcreteT, SignatureT> sourceObj)
- IReference AddDependency(IModelPlugin plugin)
- IReference AddDependency(IExternalConnection externalConnection)
- IReference AddDependency(IAIModelConnection connector)
- IReference AddDependency(ISearchServiceConnection connector)
- IReference AddDependency(IMCPConnection connection)
- IReference AddDependency(IA2AConnection connection)
- IReference AddDependency(IKnowledgeBase knowledgeBase)
- IReference AddDependency(IAINativeConnection connection)
- IObjectSignature AddDependency(IShareable sourceObj, bool fixSpecificVersion = False)
- SignatureT AddDependency<ConcreteT, SignatureT>(IShareableESpaceObject<ConcreteT, SignatureT> sourceObj, bool fixSpecificVersion = False)
- SignatureT AddDependency<ConcreteT, SignatureT>(IShareableExtensionObject<ConcreteT, SignatureT> sourceObj, bool fixSpecificVersion = False)
- SignatureT AddDependency<ConcreteT, SignatureT>(IShareableExternalLibraryObject<ConcreteT, SignatureT> sourceObj, bool fixSpecificVersion = False)
- IReference AddDependency(IExtension extension, bool fixSpecificVersion = False)
- IReference AddDependency(IExternalLibrary sourceLibrary, bool fixSpecificVersion = False)
- IObjectSignature AddDependency(IGlobalKey element, bool fixSpecificVersion = False)
- IEnumerable<IObjectSignature> AddDependency(SignatureInformation signatureInformation, Func<IKey, SignatureInformation> fetchAdditionalSignature = null, bool fixSpecificVersion = False)
- IEnumerable<IObjectSignature> AddDependency(IEnumerable<SignatureInformation> signatureInformation, Func<IKey, SignatureInformation> fetchAdditionalSignature = null, bool fixSpecificVersion = False)
- IEnumerable<IObjectSignature> AddDependency(SignatureInformation signatureInformation, Func<IKey, Task<SignatureInformation>> fetchAdditionalSignature, bool fixSpecificVersion = False)
- IEnumerable<IObjectSignature> AddDependency(IEnumerable<SignatureInformation> signatureInformation, Func<IKey, Task<SignatureInformation>> fetchAdditionalSignature, bool fixSpecificVersion = False)
- void ApplyToTextResources(Action<IObjectSignature, string, TextResourceType, string> action)
- IESpace Clone(string activationCode = null, string secretKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, IModelObject parent = null, CommitStrategy commitStrategy = ReexecuteOnConflict, LoadFlags loadFlags = None, string agentName = null)
- void Close()
- IAgent CreateAgent(string name = null, IKey key = null)
- IBusinessProcess CreateBusinessProcess(string name = null, IKey key = null)
- IClientAction CreateClientAction(string name = null, IKey key = null)
- IClientEntity CreateClientEntity(string name = null, IKey key = null)
- IClientVariable CreateClientVariable(string name = null, IKey key = null)
- IEntityDiagram CreateEntityDiagram(string name = null, IKey key = null)
- IExtensibilitySetting CreateExtensibilitySetting(string name = null, IKey key = null)
- IFolder CreateFolder(ESpaceTreeFolder parentFolder, string name = null, IKey key = null)
- IGlobalEvent CreateGlobalEvent(string name = null, IKey key = null)
- IGlobalEventHandler CreateGlobalEventHandler(string name = null, IKey key = null)
- IImage CreateImage(Byte[] binary, string originalPath, string name = null, IKey key = null)
- IImage CreateImage(Byte[] binary, string originalPath, ImageFormat format, int width, int height, string name = null, IKey key = null)
- MetadataType CreateInitialMetadata<MetadataType, ObjectType>(string name, string managedBy)
- T CreateIntegration<T>(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateMissingMetadata()
- IMobileConfigurations CreateMobileConfiguration()
- IMobileFlow CreateMobileFlow(string name = null, IKey key = null)
- IMobileTheme CreateMobileTheme(string name = null, IKey key = null)
- ISystemEvent CreateOnApplicationReady()
- ISystemEvent CreateOnApplicationResume()
- ISystemEvent CreateOnBeginWebRequest()
- ISystemEvent CreateOnSessionStart()
- IOnSyncSystemEvent CreateOnSync()
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IProcess CreateProcess(string name = null, IKey key = null)
- IResource CreateResource(Byte[] binary, string name = null, IKey key = null)
- IAppRole CreateRole(string name = null, IKey key = null)
- IScript CreateScript(string name = null, IKey key = null)
- IServerAction CreateServerAction(string name = null, IKey key = null)
- IServerEntity CreateServerEntity(string name = null, IKey key = null)
- IServiceAction CreateServiceAction(string name = null, IKey key = null)
- ISessionVariable CreateSessionVariable(bool isReadOnly = False, string name = null, IKey key = null)
- ISiteProperty CreateSiteProperty(bool isReadOnly = False, string name = null, IKey key = null)
- ISOAPService CreateSOAPService(string name = null, IKey key = null)
- IStaticEntity CreateStaticEntity(string name = null, IKey key = null)
- IStructure CreateStructure(string name = null, IKey key = null)
- ITimer CreateTimer(string name = null, IKey key = null)
- IUIFlow CreateUIFlow(string name = null, IKey key = null)
- IUserException CreateUserException(string name = null, IKey key = null)
- IWebFlow CreateWebFlow(string name = null, IKey key = null)
- IWebTheme CreateWebTheme(string name = null, IKey key = null)
- IEnumerable<IObjectSignature> DeserializeInto(Byte[] objects, IObjectSignature target)
- void DoInDetachedMode(Action action)
- T DoInDetachedMode<T>(Func<T> function)
- Byte[] GetBytesUnsafe()
- string GetDocumentation()
- IEnumerable<IMetadata> GetInitialMetadataFor<T>()
- IAnonymousStructure GetOrCreateAnonymousStructure(IEnumerable<Tuple<string, ITypeSignature>> attributes)
- IAnonymousStructure GetOrCreateAnonymousStructure(Tuple<string, ITypeSignature>[] attributes)
- IListType GetOrCreateListType(ITypeSignature elementType)
- ILocale GetOrCreateLocale(Culture culture)
- ITypeSignature GetOrCreateType(string typeName)
- IReference GetSignature()
- Byte[] GetSignatureBinary()
- SignatureInformation GetSignatureInformation(IEnumerable<IKey> targetElementKeys)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- IEnumerable<IValidationMessage> GetValidationMessages(IPlatformCapabilities platformCapabilities)
- string GetWorkingAgentName()
- CreatedByTool GetWorkingTool()
- bool IsAllowed(ModuleOperations operations, string secretKey = null)
- void LoadTextResources(string filePath)
- void Lock(string secretKey, ModuleOperations forbiddenOperations = All)
- IEnumerable<IObjectSignature> Merge(IEnumerable<IObjectSignature> objects, Dictionary<IObjectSignature, MergeOption> options = null, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature>> pairings = null, IEnumerable<ValueTuple<IObjectSignature, IKey>> desiredKeys = null)
- void RefreshDependencies(IShareable[] sourceElements)
- void RefreshDependencies(IEnumerable<IShareable> sourceElements)
- void RefreshDependencies(IESpace[] sourceESpaces)
- void RefreshDependencies(IEnumerable<IReference> references)
- void RefreshDependencies(IReference reference)
- void RefreshDependencies(IEnumerable<IESpace> sourceESpaces, bool updateSpecificVersion = False)
- bool RefreshDependencies(IEnumerable<IExternalLibrary> producerLibraries, bool updateSpecificVersion = False)
- void RefreshDependencies(IEnumerable<IGlobalKey> elements, bool updateSpecificVersion = False)
- bool RefreshDependencies(IEnumerable<IModuleSignature> producerModuleSignatures, IKey ownerApplicationKey, string ownerDatabaseName)
- void RefreshDependencies(SignatureInformation signatureInformation, Func<IKey, SignatureInformation> fetchAdditionalSignature = null, bool updateSpecificVersion = False)
- void RefreshDependencies(IEnumerable<SignatureInformation> signatureInformation, Func<IKey, SignatureInformation> fetchAdditionalSignature = null, bool updateSpecificVersion = False)
- void RefreshDependencies(SignatureInformation signatureInformation, Func<IKey, Task<SignatureInformation>> fetchAdditionalSignature, bool updateSpecificVersion = False)
- void RefreshDependencies(IEnumerable<SignatureInformation> signatureInformation, Func<IKey, Task<SignatureInformation>> fetchAdditionalSignature, bool updateSpecificVersion = False)
- void RefreshDependency(IGlobalKey element, bool updateSpecificVersion = False)
- IESpace Reload(string secretKey = null, string productKey = null)
- IESpace ReloadWithUpgradedModelPlugins(IEnumerable<ValueTuple<IRequiredModelPlugin, IModelPluginUpdateInformation>> pluginsToUpgrade, string secretKey = null, string productKey = null)
- void RemoveUnusedDependencies()
- Byte[] SaveDelta()
- void SaveTextResources(string outputFolder, TextResourcesFileFormat format = Excel)
- Byte[] Serialize(IEnumerable<IObjectSignature> objects)
- void SetExtensibilityConfigurations(string expression)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void Unlock(string secretKey)
- IDependencyGraph UpdateDependencyGraph(Func<ValueTuple<IKey, string, string>, IEnumerable<ValueTuple<IKey, string, SegmentationKind, string, string, string>>> getDependencies)

### interface IESpaceDescriptor : IModuleDescriptor, IObjectDescriptor
- IChildCollection AbstractionsManagerChildCollection { get; }
- IChildCollection<IESpace, IAgentManifest> AgentManifestChildCollection { get; }
- IChildCollection AgentsChildCollection { get; }
- IChildCollection AnonymousStructuresChildCollection { get; }
- IChildCollection<IESpace, IBasicType> BasicTypesChildCollection { get; }
- IChildCollection BusinessProcessesChildCollection { get; }
- IChildCollection ClientActionsChildCollection { get; }
- IChildCollection ClientVariablesChildCollection { get; }
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DBMSProperty { get; }
- IProperty DefaultMobileThemeProperty { get; }
- IProperty DefaultScreenProperty { get; }
- IProperty DefaultTransitionProperty { get; }
- IProperty DefaultWebThemeProperty { get; }
- IChildCollection EntitiesChildCollection { get; }
- IChildCollection EntityDiagramsChildCollection { get; }
- IChildCollection ExtensibilitySettingsChildCollection { get; }
- IChildCollection FoldersChildCollection { get; }
- IChildCollection GlobalEventHandlersChildCollection { get; }
- IChildCollection GlobalEventsChildCollection { get; }
- IProperty HideWidgetsDistributedWithIDEProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection ImagesChildCollection { get; }
- IChildCollection<IESpace, IIntegration> IntegrationsChildCollection { get; }
- IProperty InvalidCurrencyProperty { get; }
- IProperty InvalidDateProperty { get; }
- IProperty InvalidDateTimeProperty { get; }
- IProperty InvalidDecimalProperty { get; }
- IProperty InvalidEmailProperty { get; }
- IProperty InvalidIntegerProperty { get; }
- IProperty InvalidNumericPasswordProperty { get; }
- IProperty InvalidPhoneProperty { get; }
- IProperty InvalidTextProperty { get; }
- IProperty InvalidTimeProperty { get; }
- IProperty IsInIsolatedProperty { get; }
- IProperty IsMultiTenantProperty { get; }
- IProperty IsTemplateBundleProperty { get; }
- IProperty IsUserProviderProperty { get; }
- IProperty JavaScriptProperty { get; }
- IProperty JQueryVersionProperty { get; }
- IProperty KindProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IChildCollection ListTypesChildCollection { get; }
- IChildCollection LocalesChildCollection { get; }
- IProperty MandatoryInputProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection MobileConfigurationsChildCollection { get; }
- IChildCollection MobileFlowsChildCollection { get; }
- IChildCollection MobileThemesChildCollection { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IChildCollection PreviousScreenChildCollection { get; }
- IChildCollection ProcessesChildCollection { get; }
- IChildCollection ReferencesChildCollection { get; }
- IChildCollection RequiredModelPluginsChildCollection { get; }
- IChildCollection ResourcesChildCollection { get; }
- IProperty RetryIntervalProperty { get; }
- IProperty RetrySynchronizationsProperty { get; }
- IChildCollection RoleExceptionsChildCollection { get; }
- IChildCollection RolesChildCollection { get; }
- IChildCollection ScriptsChildCollection { get; }
- IChildCollection ServerActionsChildCollection { get; }
- IProperty ServerRequestTimeoutProperty { get; }
- IChildCollection ServiceActionsChildCollection { get; }
- IChildCollection SessionVariablesChildCollection { get; }
- IChildCollection SitePropertiesChildCollection { get; }
- IChildCollection SOAPClientsChildCollection { get; }
- IChildCollection SOAPServicesChildCollection { get; }
- IProperty SplashScreenProperty { get; }
- IChildCollection StructuresChildCollection { get; }
- IProperty SynchronizeOnOnlineProperty { get; }
- IProperty SynchronizeOnResumeProperty { get; }
- IChildCollection SystemActionsChildCollection { get; }
- IChildCollection SystemClientActionsChildCollection { get; }
- IChildCollection<IESpace, ISystemException> SystemExceptionsChildCollection { get; }
- IChildCollection<IESpace, IRoleSignature> SystemRolesChildCollection { get; }
- IChildCollection<IESpace, IStaticEntitySignature> SystemStaticEntitiesChildCollection { get; }
- IChildCollection<IESpace, IStructureSignature> SystemStructuresChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IChildCollection TimersChildCollection { get; }
- IProperty UpgradeCompleteProperty { get; }
- IProperty UpgradeFailedOnDataModelProperty { get; }
- IProperty UpgradeFailedOnResourcesProperty { get; }
- IProperty UpgradeFailedProperty { get; }
- IProperty UpgradeRequiredProperty { get; }
- IProperty UpgradeRequiredWithDataLossProperty { get; }
- IProperty UseCookiesProperty { get; }
- IProperty UseDefaultThemeExceptionHandlerProperty { get; }
- IChildCollection UserExceptionsChildCollection { get; }
- IProperty UsesCacheProperty { get; }
- IChildCollection WebFlowsChildCollection { get; }
- IProperty WebScreenRenderingModeProperty { get; }
- IProperty WebServicesNamespaceProperty { get; }
- IChildCollection WebThemesChildCollection { get; }

### interface IESpaceVersion
- Guid Digest { get; }
- DateTime SaveDate { get; }

### interface IExtendedProperty : IExtendedPropertySignature, IObject
- IExtendedPropertyDescriptor Descriptor { get; }
- string Property { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IExtendedPropertyDescriptor : IExtendedPropertySignatureDescriptor, IObjectDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IExtendedPropertySignature : IObjectSignature
- IExtendedPropertySignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Property { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IExtendedPropertySignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty PropertyProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface IFlow : IFlowSignature, IObject
- string CreatedBy { get; set; }
- string Description { get; set; }
- IFlowDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IFlowDescriptor : IFlowSignatureDescriptor, IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IFlowNode : IFlowNodeSignature, IObject
- IEnumerable<IConnector> Connectors { get; }
- IFlowNodeDescriptor Descriptor { get; }
- int HorizontalPosition { get; set; }
- IEnumerable<IConnector> IncomingConnectors { get; }
- bool IsDisabled { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- int VerticalPosition { get; set; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IFlowNodeDescriptor : IFlowNodeSignatureDescriptor, IObjectDescriptor
- IProperty ConnectorsProperty { get; }
- IProperty HorizontalPositionProperty { get; }
- IProperty IsDisabledProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty VerticalPositionProperty { get; }

### interface IFlowNodeSignature : IObjectSignature
- IFlowNodeSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IFlowNodeSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }

### interface IFlowSignature : IObjectSignature
- IFlowSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IFlowSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IFolder : IFolderSignature, IShareableESpaceObject<IFolder, IFolderSignature>
- string CreatedBy { get; set; }
- string Description { get; set; }
- IFolderDescriptor Descriptor { get; }
- IEnumerable<IObject> Entries { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }

### interface IFolderDescriptor : IFolderSignatureDescriptor, IObjectDescriptor

### interface IFolderSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IFolderSignatureDescriptor Descriptor { get; }
- IEnumerable<IObjectSignature> Entries { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- ESpaceTreeFolder ParentFolder { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IFolderSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty ParentFolderProperty { get; }

### interface IGlobalKey : IEquatable<IGlobalKey>
- IKey ModuleKey { get; }
- IKey ObjectKey { get; }
- string SerializeToString()

### interface IHeader
- string ContentDigest { get; }
- string DependencyGraph { get; }
- IEnumerable<MobileFramework> MobileFrameworks { get; }
- string PartialOmlBaseDigest { get; }
- bool RequiresElementsReordering { get; }
- bool RequiresModelPlugins { get; }
- bool RequiresRecover { get; }
- bool RequiresUpgrades { get; }

### interface IInputParameter : IInputParameterSignature, IObject
- ITypeSignature DataType { get; set; }
- string Description { get; set; }
- IInputParameterDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }
- string Name { get; set; }
- void SetDefaultValue(ExpressionDefinition value)

### interface IInputParameterDescriptor : IInputParameterSignatureDescriptor, IObjectDescriptor

### interface IInputParameterSignature : IObjectSignature
- ITypeSignature DataType { get; }
- IExpression DefaultValue { get; }
- string Description { get; }
- IInputParameterSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; }
- bool IsMandatory { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IInputParameterSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IKey : IComparable<IKey>, IEquatable<IKey>
- IKey ParentKey { get; }
- IKey CreateNewKeyBasedOnThis(object[] extraInfo)
- string SerializeToString(bool useDatabaseFormat = True)
- IKey WithNewParentKey(IKey parentKey)

### interface IKeyMetadata : IMetadata
- IKeyMetadataDescriptor Descriptor { get; }
- IKey Value { get; set; }

### interface IKeyMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface ILocalVariable : IObject
- string CreatedBy { get; set; }
- ITypeSignature DataType { get; set; }
- IExpression DefaultValue { get; }
- string Description { get; set; }
- ILocalVariableDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetDefaultValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ILocalVariableDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IMetadata : IObject
- string Category { get; set; }
- IMetadataDescriptor Descriptor { get; }
- bool DiscardOnDuplicate { get; set; }
- bool Hidden { get; set; }
- string ManagedBy { get; }
- bool Mandatory { get; set; }
- string Name { get; }
- bool ReadOnly { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IMetadataDescriptor : IObjectDescriptor
- IProperty CategoryProperty { get; }
- IProperty DiscardOnDuplicateProperty { get; }
- IProperty HiddenProperty { get; }
- IProperty ManagedByProperty { get; }
- IProperty MandatoryProperty { get; }
- IProperty NameProperty { get; }
- IProperty ReadOnlyProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IMobileConfigurations : IObject
- IMobileConfigurationsDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- INativeSplashScreenConfiguration NativeSplashScreenConfiguration { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IMobileConfigurationsDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection NativeSplashScreenConfigurationChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IMobileFrameworksConfiguration
- bool IsCapacitorSupportOverridden { get; set; }
- IEnumerable<MobileFramework> MobileFrameworks { get; }

### interface IModelObject : IVersionedObject
- IEnumerable<IModelObject> Children { get; }
- IChildCollection CollectionDescriptor { get; }
- IClassDescriptor Descriptor { get; }
- string DisplayName { get; }
- long Generation { get; }
- IGlobalKey GlobalKey { get; }
- bool IsDetached { get; }
- IKey Key { get; }
- IModelObject Parent { get; }
- IEnumerable<IModelObject> Referrers { get; }
- bool WasDeleted { get; }
- void Delete()
- Type GetInterface()

### interface IModelObjectAddress
- string SerializeToString()
- bool TryLookup(IESpace eSpace, out IModelObject obj)

### interface IModelObjectIdentifier
- IModelObject Target { get; }

### interface IModelObjectIdentifier<T> : IModelObjectIdentifier
- T Target { get; }

### interface IModelObjectMetadata : IMetadata
- IModelObjectMetadataDescriptor Descriptor { get; }
- IObjectSignature Value { get; set; }

### interface IModelObjectMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface IModelServices
- Configuration Configuration { get; }
- IEnumerable<IESpace> LoadedESpaces { get; }
- IEnumerable<Type> ModelInterfaces { get; }
- EventHandler<IModelObject> DeletingObject
- EventHandler<ValueTuple<string, Version>> ModelPluginLoaded
- EventHandler<IModule> ModuleCloned
- EventHandler<IModule> ModuleCreated
- EventHandler<IModule> ModuleLoaded
- EventHandler<IModule> ModuleUnloaded
- ResolveModelPluginEventHandler ResolveModelPlugin
- ResolveModuleSignatureEventHandler ResolveModuleSignature
- T Clone<T>(Byte[] oml, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T Clone<T>(string omlPath, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IApplication CloneApplication(Byte[] oap, string activationCode = "", string secretKey = null, string productKey = null, IKey clonedApplicationKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IApplication CloneApplication(string oapPath, string activationCode = "", string secretKey = null, string productKey = null, IKey clonedApplicationKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace CloneESpace(string omlPath, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace CloneESpace(Byte[] oml, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, LoadFlags loadFlags = None)
- Byte[] CloneESpaceWithoutLoad(Byte[] oml, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, string name = null, string description = null, Byte[] icon = null)
- Byte[] CloneESpaceWithoutLoad(string omlPath, string activationCode = null, string secretKey = null, string productKey = null, IKey clonedESpaceKey = null, bool enableTransactions = False, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, string name = null, string description = null, Byte[] icon = null)
- IReadOnlyList<ValueTuple<Byte[], IKey, IKey>> CloneModulesAndRewireReferences(IReadOnlyList<ValueTuple<Byte[], string>> modulesToClone)
- T Create<T>(SegmentationKind kind, string name = null, string activationCode = null, bool isTemplatesBundleESpace = False, IKey key = null, bool enableTransactions = False, Action<T> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False)
- IA2AConnection CreateA2AConnection(string name = "Connection", IKey key = null, bool enableTransactions = False, Action<IA2AConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAIModelConnection CreateAIModelConnection(string name = "Connector", IKey key = null, bool enableTransactions = False, Action<IAIModelConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAINativeConnection CreateAINativeConnection(string name = "Connection", IKey key = null, bool enableTransactions = False, Action<IAINativeConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IApplication CreateApplication(SegmentationKind kind, string name, string description = "", string activationCode = "", IKey key = null, bool enableTransactions = False, Action<IApplication> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace CreateESpace(SegmentationKind kind, string name = null, string activationCode = null, bool isTemplatesBundleESpace = False, IKey key = null, PlatformServerVersion targetPlatform = O11, bool enableTransactions = False, Action<IESpace> setup = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False, string agentName = null)
- IExtension CreateExtension(string name = "Extension", string activationCode = null, IKey key = null, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, Action<IExtension> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalConnection CreateExternalConnection(string name = "Connection", IKey key = null, bool enableTransactions = False, Action<IExternalConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalLibrary CreateExternalLibrary(Byte[] package, out IList<IValidationMessage> validationMessages, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IGlobalKey CreateGlobalKey(IKey moduleKey, IKey objectKey)
- IKnowledgeBase CreateKnowledgeBase(string name = "Connector", IKey key = null, bool enableTransactions = False, Action<IKnowledgeBase> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IMCPConnection CreateMCPConnection(string name = "Connection", IKey key = null, bool enableTransactions = False, Action<IMCPConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModelPlugin CreateModelPlugin(Byte[] package, out IList<IValidationMessage> validationMessages, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISearchServiceConnection CreateSearchServiceConnection(string name = "Connector", IKey key = null, bool enableTransactions = False, Action<ISearchServiceConnection> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISolution CreateSolution(string name, IKey key = null, string versionName = null, string description = "", string activationCode = "", bool enableTransactions = False, Action<ISolution> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISolution CreateTransientSolution(string name, string activationCode = "", bool enableTransactions = False, Action<ISolution> setup = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IMatchTree Diff(IESpace localESpace, IESpace foreignESpace, IESpace baseESpace = null, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, IObjectSignature>> pairings = null, bool matchByStructureInsteadOfIdentity = False, bool skipSpecificMatchers = False)
- string FixName(string name)
- string GenerateSecretKey()
- string GetActivationCode(Byte[] fileContent, out string error)
- IHeader GetHeader(Byte[] oml)
- IHeader GetHeader(Stream oml)
- IModelPlugin GetOrCreateModelPlugin(Assembly assembly, out IList<IValidationMessage> validationMessages, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModelPlugin GetOrCreateModelPlugin(string assemblyName, Version assemblyVersion, out IList<IValidationMessage> validationMessages, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T GetPluginService<T>()
- bool IsFromDynamicallyLoadedModelPlugin(object obj)
- bool IsFromDynamicallyLoadedModelPlugin(object obj, out string assemblyName, out Version assemblyVersion)
- bool IsModelInterface(Type type)
- IA2AConnection LoadA2AConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IA2AConnection LoadA2AConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAIModelConnection LoadAIModelConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAIModelConnection LoadAIModelConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAINativeConnection LoadAINativeConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IAINativeConnection LoadAINativeConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IApplication LoadApplication(string oapPath, string secretKey = null, string productKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IApplication LoadApplication(Byte[] oap, string secretKey = null, string productKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T LoadComponent<T>(string omlPath, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IOMLComponent LoadComponent(string omlPath, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T LoadComponent<T>(Byte[] oml, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IOMLComponent LoadComponent(Byte[] oml, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T LoadComponent<T>(string omlPath, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IOMLComponent LoadComponent(string omlPath, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- T LoadComponent<T>(Byte[] oml, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IOMLComponent LoadComponent(Byte[] oml, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace LoadESpace(string omlPath, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, Byte[] partialOml = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False)
- IESpace LoadESpace(string omlPath, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, Byte[] partialOml = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False)
- IESpace LoadESpace(Byte[] oml, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, Byte[] partialOml = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False, string agentName = null)
- IESpace LoadESpace(Byte[] oml, CancellationToken cancellationToken, LoadFlags loadFlags = None, string secretKey = null, string productKey = null, IServerInformationForUpgrade upgradeInformation = null, bool enableTransactions = False, Byte[] partialOml = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False, string agentName = null)
- IExtension LoadExtension(string xifPath, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExtension LoadExtension(Byte[] xif, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalConnection LoadExternalConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalConnection LoadExternalConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalLibrary LoadExternalLibrary(Byte[] xif, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExternalLibrary LoadExternalLibrary(string xifPath, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IKnowledgeBase LoadKnowledgeBase(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IKnowledgeBase LoadKnowledgeBase(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IMCPConnection LoadMCPConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IMCPConnection LoadMCPConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModelPlugin LoadModelPlugin(string xifPath, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModelPlugin LoadModelPlugin(Byte[] xif, bool includeResources = True, FileStorageStrategy resourceStorageStrategy = InMemory, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModuleSignature LoadModuleSignature(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IModuleSignature LoadModuleSignature(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISearchServiceConnection LoadSearchServiceConnection(string signaturePath, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISearchServiceConnection LoadSearchServiceConnection(Byte[] signature, SignatureMetadata signatureMetadata = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISolution LoadSolution(string ospPath, string secretKey = null, string productKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- ISolution LoadSolution(Byte[] osp, string secretKey = null, string productKey = null, bool enableTransactions = False, CommitStrategy commitStrategy = ReexecuteOnConflict)
- bool Merge(IESpace myESpace, IESpace otherESpace, IESpace baseESpace, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, IObjectSignature>> pairings = null, bool matchByStructureInsteadOfIdentity = False, bool skipSpecificMatchers = False)
- bool Merge(IESpace myESpace, IESpace otherESpace, IESpace baseESpace, out string reasonForFailure, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, IObjectSignature>> pairings = null, bool matchByStructureInsteadOfIdentity = False, bool skipSpecificMatchers = False)
- IObject MoveObject(IObject source, IObject newParent)
- IKey NewKey()
- IKey NewKeyBasedOn(object[] info)
- IGlobalKey ParseGlobalKey(string value)
- IKey ParseKey(string value)
- IModelObjectAddress ParseObjectAddress(string value)
- void SetLogger(ILogger logger, ILoggerFactory loggerFactory = null)
- bool TryParseGlobalKey(string value, out IGlobalKey key)
- bool TryParseKey(string value, out IKey key)

### interface IModuleSignature
- IKey ApplicationKey { get; }
- string DatabaseName { get; }
- string Description { get; }
- string ExtensibilityConfigurations { get; }
- Byte[] Icon { get; }
- string JQueryVersion { get; }
- IKey Key { get; }
- ReferenceKind ModuleKind { get; }
- SegmentationKind ModuleType { get; }
- string Name { get; }
- Byte[] SignatureBinary { get; }
- Guid SignatureDigest { get; }

### interface INativeSplashScreenConfiguration : IObject
- string BackgroundColor { get; set; }
- IImageSignature BrandingImage { get; set; }
- INativeSplashScreenConfigurationDescriptor Descriptor { get; }
- ScreenTransition ExitAnimation { get; set; }
- string LoadingBackgroundColor { get; set; }
- IImageSignature LoadingBrandingImage { get; set; }
- string LoadingMessage { get; set; }
- string LoadingMessageColor { get; set; }
- LoadingMessagePosition LoadingMessagePosition { get; set; }
- LoadingScreenType LoadingScreenType { get; set; }
- LoadingPatternType LoadingSpinner { get; set; }
- string LoadingSpinnerColor { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface INativeSplashScreenConfigurationDescriptor : IObjectDescriptor
- IProperty BackgroundColorProperty { get; }
- IProperty BrandingImageProperty { get; }
- IProperty ExitAnimationProperty { get; }
- IProperty LoadingBackgroundColorProperty { get; }
- IProperty LoadingBrandingImageProperty { get; }
- IProperty LoadingMessageColorProperty { get; }
- IProperty LoadingMessagePositionProperty { get; }
- IProperty LoadingMessageProperty { get; }
- IProperty LoadingScreenTypeProperty { get; }
- IProperty LoadingSpinnerColorProperty { get; }
- IProperty LoadingSpinnerProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface INeoApp : IOMLComponent

### interface INeoLibrary : IOMLComponent

### interface INumericMetadata : IMetadata
- INumericMetadataDescriptor Descriptor { get; }
- int? Value { get; set; }

### interface INumericMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface IObject : IObjectSignature
- bool CanMoveAfter { get; }
- bool CanMoveBefore { get; }
- IObjectDescriptor Descriptor { get; }
- int IndexInParent { get; }
- bool CanMoveToNewAbsoluteIndex(int newAbsoluteIndex)
- bool CanMoveToNewRelativeIndex(int newRelativeIndex)
- IObjectSignature Copy(IObjectSignature obj)
- IEnumerable<IObjectSignature> Copy(IEnumerable<IObjectSignature> objects)
- T CreateSibling<T>(string name = null, IKey key = null)
- IModelObject CreateSibling(Type type, string name = null, IKey key = null)
- IObjectSignature Duplicate(IObjectSignature obj)
- IEnumerable<IObjectSignature> Duplicate(IEnumerable<IObjectSignature> objects)
- IEnvironment GetEnvironment(IExpressionProperty property)
- void MoveAfter()
- void MoveAfterSibling(IObject sibling)
- void MoveBefore()
- void MoveBeforeSibling(IObject sibling)
- void MoveToEnd()
- void MoveToNewAbsoluteIndex(int newAbsoluteIndex)
- void MoveToNewRelativeIndex(int newRelativeIndex)

### interface IObjectDescriptor : IObjectSignatureDescriptor

### interface IObjectSignature : IModelObject
- IObjectSignatureDescriptor Descriptor { get; }
- string Digest { get; }
- bool IsSystemObject { get; }
- bool IsValid { get; }
- IKey ObjectKey { get; }
- string ReadableIdentifier { get; }
- IEnumerable<T> GetAllDescendantsOfType<T>()
- IESpace GetESpace()
- IEnumerable<IValidationMessage> GetValidationMessages(bool includeMessagesFromDescendants = True)
- void ReplaceReferences(IObjectSignature previousObject, IObjectSignature newObject)

### interface IObjectSignatureDescriptor : IClassDescriptor
- IProperty ReadableIdentifierProperty { get; }

### interface IObjectWithMatch : IObjectSignature
- IMatch Match { get; }

### interface IObjectWithNodes : IObject
- IEnumerable<IActionNode> Nodes { get; }
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)

### interface IObjectWithOriginalName : IObjectSignature
- string OriginalName { get; }

### interface IObjectWithToolChangeTracking : IObjectSignature
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }

### interface IOMLComponent
- bool Is<T>()

### interface IOutputFormat : IObject
- string Description { get; set; }
- IOutputFormatDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<IOutputFormatAttribute> OutputFormatAttributes { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IStructureSignature Type { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IOutputFormatAttribute CreateOutputFormatAttribute(IKey key = null)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IOutputFormatAttribute : IObject
- IAttributeSignature Attribute { get; set; }
- string Description { get; set; }
- IOutputFormatAttributeDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IOutputFormatAttributeDescriptor : IObjectDescriptor
- IProperty AttributeProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IOutputFormatDescriptor : IObjectDescriptor
- IProperty DescriptionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection OutputFormatAttributesChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TypeProperty { get; }

### interface IOutputParameter : IObject, IOutputParameterSignature
- ITypeSignature DataType { get; set; }
- string Description { get; set; }
- IOutputParameterDescriptor Descriptor { get; }
- string Name { get; set; }
- void SetDefaultValue(ExpressionDefinition value)

### interface IOutputParameterDescriptor : IObjectDescriptor, IOutputParameterSignatureDescriptor

### interface IOutputParameterSignature : IObjectSignature
- ITypeSignature DataType { get; }
- IExpression DefaultValue { get; }
- string Description { get; }
- IOutputParameterSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IOutputParameterSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IPluginService
- void StandaloneInitialize()

### interface IReference : IObject
- IAgentManifestSignature AgentManifest { get; }
- IDependency AsDependency { get; }
- IEnumerable<IBusinessProcessSignature> BusinessProcesses { get; }
- IEnumerable<IClientActionSignature> ClientActions { get; }
- string CreatedBy { get; set; }
- CreatedByTool CreatedByTool { get; set; }
- string DependencyGraph { get; set; }
- string Description { get; set; }
- IReferenceDescriptor Descriptor { get; }
- IEnumerable<IEntitySignature> Entities { get; }
- SegmentationKind ESpaceType { get; set; }
- IEnumerable<IGlobalEvent> Events { get; }
- IEnumerable<IFolderSignature> Folders { get; }
- IEnumerable<IGlobalEventSignature> GlobalEvents { get; }
- Guid Hash { get; set; }
- Byte[] Icon { get; set; }
- IEnumerable<IImageSignature> Images { get; }
- IEnumerable<IIntegrationReferenceAction> IntegrationActions { get; }
- bool IsFixedVersion { get; }
- bool IsLibrary { get; }
- bool IsMobilePlugin { get; set; }
- JQueryVersion JQueryVersion { get; set; }
- ReferenceKind Kind { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<IMobileFlowSignature> MobileFlows { get; }
- IEnumerable<MobileFramework> MobileFrameworks { get; }
- IEnumerable<IMobileThemeSignature> MobileThemes { get; }
- IRequiredModelPlugin ModelPlugin { get; }
- IKey ModuleKey { get; }
- SegmentationKind ModuleType { get; set; }
- string Name { get; set; }
- IEnumerable<IProcessSignature> Processes { get; }
- string ProviderType { get; }
- string ReactBundleName { get; set; }
- string ReactModuleName { get; set; }
- IEnumerable<IResourceSignature> Resources { get; }
- string Revision { get; }
- IEnumerable<IAppRoleSignature> Roles { get; }
- IEnumerable<IScriptSignature> Scripts { get; }
- IEnumerable<IServerActionSignature> ServerActions { get; }
- IEnumerable<IServiceActionSignature> ServiceActions { get; }
- string SpecificVersionHash { get; }
- IEnumerable<IStructureSignature> Structures { get; }
- string StylesheetModuleName { get; set; }
- string Version { get; }
- IEnumerable<IWebFlowSignature> WebFlows { get; }
- IEnumerable<IWebThemeSignature> WebThemes { get; }
- IEnumerable<IWidgetDefinitionSignature> WidgetDefinitions { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- IDependencyGraph UpdateDependencyGraph(Func<ValueTuple<IKey, string, string>, IEnumerable<ValueTuple<IKey, string, SegmentationKind, string, string, string>>> getDependencies)

### interface IReferenceDescriptor : IObjectDescriptor
- IChildCollection AgentManifestChildCollection { get; }
- IChildCollection BusinessProcessesChildCollection { get; }
- IChildCollection ClientActionsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DependencyGraphProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection EntitiesChildCollection { get; }
- IProperty ESpaceTypeProperty { get; }
- IChildCollection FoldersChildCollection { get; }
- IChildCollection GlobalEventsChildCollection { get; }
- IProperty HashProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection ImagesChildCollection { get; }
- IProperty IsMobilePluginProperty { get; }
- IProperty JQueryVersionProperty { get; }
- IProperty KindProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection MobileFlowsChildCollection { get; }
- IChildCollection MobileThemesChildCollection { get; }
- IProperty ModelPluginProperty { get; }
- IProperty ModuleKeyProperty { get; }
- IProperty ModuleTypeProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection ProcessesChildCollection { get; }
- IProperty ProviderTypeProperty { get; }
- IProperty ReactBundleNameProperty { get; }
- IProperty ReactModuleNameProperty { get; }
- IChildCollection ResourcesChildCollection { get; }
- IProperty RevisionProperty { get; }
- IChildCollection RolesChildCollection { get; }
- IChildCollection ScriptsChildCollection { get; }
- IChildCollection ServerActionsChildCollection { get; }
- IChildCollection ServiceActionsChildCollection { get; }
- IProperty SpecificVersionHashProperty { get; }
- IChildCollection StructuresChildCollection { get; }
- IProperty StylesheetModuleNameProperty { get; }
- IProperty VersionProperty { get; }
- IChildCollection WebFlowsChildCollection { get; }
- IChildCollection WebThemesChildCollection { get; }
- IChildCollection WidgetDefinitionsChildCollection { get; }

### interface ISequence : IEnumerable
- void SetOrderTo(IEnumerable<IModelObject> order)

### interface ISequence<T> : IEnumerable<T>, ISequence
- void MoveAfterSibling(T sibling, T element)
- void MoveBeforeSibling(T sibling, T element)
- void MoveToEnd(T element)
- void MoveToStart(T element)
- void SetOrderTo(IEnumerable<T> order)

### interface IServerInformationForUpgrade
- IDictionary<IKey, string> ExternalEntityDatabaseProviders { get; }
- string ServerDatabaseProviderKey { get; }

### interface IShareable : IModelObject

### interface IShareableESpaceObject : IObject, IShareable

### interface IShareableESpaceObject<ConcreteT, SignatureT> : IShareableESpaceObject

### interface ISpecialListEntry : IObject, ISpecialListEntrySignature
- ISpecialListEntryDescriptor Descriptor { get; }
- string Option { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- string Value { get; set; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISpecialListEntryDescriptor : IObjectDescriptor, ISpecialListEntrySignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface ISpecialListEntrySignature : IObjectSignature
- ISpecialListEntrySignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Option { get; }
- string Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface ISpecialListEntrySignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty OptionProperty { get; }
- IProperty ValueProperty { get; }

### interface ITextMetadata : IMetadata
- ITextMetadataDescriptor Descriptor { get; }
- string Value { get; set; }

### interface ITextMetadataDescriptor : IMetadataDescriptor
- IProperty ValueProperty { get; }

### interface ITextResource : IModelObject
- ITextResourceDescriptor Descriptor { get; }
- string Id { get; }
- string SourceText { get; }
- TranslationBehavior TranslationBehavior { get; set; }
- IEnumerable<ITranslation> Translations { get; }

### interface ITextResourceDescriptor : IObjectSignatureDescriptor
- IProperty IdProperty { get; }
- IProperty SourceTextProperty { get; }
- IProperty TranslationBehaviorProperty { get; }
- IChildCollection TranslationsChildCollection { get; }

### interface IThemeValues : IObject, IThemeValuesSignature
- IThemeValuesDescriptor Descriptor { get; }
- string PropertyDisplayName { get; set; }
- string PropertyName { get; set; }
- string PropertyValue { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IThemeValuesDescriptor : IObjectDescriptor, IThemeValuesSignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IThemeValuesSignature : IObjectSignature
- IThemeValuesSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string PropertyDisplayName { get; }
- string PropertyName { get; }
- string PropertyValue { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IThemeValuesSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty PropertyDisplayNameProperty { get; }
- IProperty PropertyNameProperty { get; }
- IProperty PropertyValueProperty { get; }

### interface ITopLevelReferenceElement : IModelObject
- Guid CompatibilitySignatureHash { get; set; }
- Guid FullSignatureHash { get; set; }

### interface ITranslation : IModelObject
- Culture Culture { get; }
- ITranslationDescriptor Descriptor { get; }
- ITextResource Parent { get; }
- string Value { get; set; }

### interface ITranslationDescriptor : IObjectSignatureDescriptor
- IProperty CultureProperty { get; }
- IProperty ValueProperty { get; }

### interface IValidationMessage
- string Detail { get; }
- int HelpRef { get; }
- bool Hidden { get; set; }
- string Id { get; }
- string InContextDetail { get; }
- string Message { get; }
- IObjectSignature Owner { get; }
- IEnumerable<string> Properties { get; }
- ValidationMessageType Type { get; }

### enum MergeOption
- None
- IncludeChildren
- IncludeDependencies

### static class MethodExtensions
- SegmentationKind GetESpaceKind(Byte[] fileByteArray)
- FileType GetFileType(Byte[] fileByteArray)
- ValueTuple<Version, Version> GetVersions(Byte[] file)
- bool HasSystemComponents(Byte[] fileByteArray)
- bool IsIndependentModulesApplication(Byte[] application)
- bool IsModuleOperationAllowed(Byte[] eSpace, ModuleOperations operations)
- bool IsModuleOperationAllowed(Byte[] eSpace, ModuleOperations operations, string secretKey)
- bool IsSystemApplication(IApplication app)
- bool IsSytemApplication(Byte[] fileByteArray)

### static class ModelExtensions
- T Above<T>(T node, IFlowNode referenceNode, bool snapToGrid = False)
- T Above<T>(T node, IFlowNode referenceNode, int separation, bool snapToGrid = False)
- T At<T>(IEnumerable<T> items, int horizontalPosition, int verticalPosition)
- T Below<T>(T node, IFlowNode referenceNode, bool snapToGrid = False)
- T Below<T>(T node, IFlowNode referenceNode, int separation, bool snapToGrid = False)
- T ConnectedAbove<T>(T node, IFlowNode referenceNode, int separation = 1773, bool snapToGrid = False)
- T ConnectedBelow<T>(T node, IFlowNode referenceNode, int separation = 1773, bool snapToGrid = False)
- T ConnectedToTheLeftOf<T>(T node, IFlowNode referenceNode, int separation = 1773, bool snapToGrid = False)
- T ConnectedToTheRightOf<T>(T node, IFlowNode referenceNode, int separation = 1773, bool snapToGrid = False)
- IAssignment CreateAssignment(IAssignNode assign, ExpressionDefinition variable, ExpressionDefinition value)
- IMatchTree Diff(IESpace localESpace, IESpace foreignESpace, IESpace baseESpace = null, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, IObjectSignature>> pairings = null, bool matchByStructureInsteadOfIdentity = False)
- T EncloseIn<T>(IEnumerable<IWidget> widgets)
- T EncloseIn<T>(IWidget widget)
- IWidget EncloseIn(IEnumerable<IWidget> widgets, Type containerType)
- IWidget EncloseIn(IWidget widget, Type containerType)
- IEnumerable<T> GetAllDescendantsOfType<T>(IModelObject obj)
- IEnumerable<IModelObject> GetAllDescendantsOfType(IModelObject obj, Type type)
- IEnumerable<IRequiredModelPlugin> GetAllowedModelPlugins(IObjectSignature context)
- T GetAncestorOfType<T>(IModelObject obj)
- IExpression GetArgumentValue(IEnumerable<IArgument> arguments, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IEnumerable<IAIArgument> arguments, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ILifeCycleDatabaseEvent obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IActionHandler obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IToolReference obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IExecuteClientActionNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IExecuteServerActionNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IRefreshDataNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IJavaScriptNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ISQLNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IDestinationNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ITriggerNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ITriggerGlobalNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ICallAgentNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ICallAgentManifestNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IEventHandler obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IWebBlockInstanceWidget obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IBuiltinEvent obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IEvent obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IBuiltinEvent obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IUILifeCycleEvent obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IMobileBlockInstanceWidget obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ITimer obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IGlobalEventHandler obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IExecuteProcessNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IHumanActivityNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IActivityDataItem obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IAutomaticActivityNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(IHumanActivityNode obj, IInputParameterSignature parameter)
- IExpression GetArgumentValue(ICallWorkflowNode obj, IInputParameterSignature parameter)
- IEnumerable<T> GetDirectChildrenOfType<T>(IModelObject obj)
- IEnumerable<IModelObject> GetDirectChildrenOfType(IModelObject obj, Type type)
- IRecordLiteralField GetField(IRecordLiteralExpression recordLiteral, IAttributeSignature attribute)
- IRecordLiteralField GetField(IRecordLiteralExpression recordLiteral, string fieldName)
- IModelObjectAddress GetObjectAddress(IModelObject obj)
- IModelObjectIdentifier<T> GetObjectId<T>(T obj)
- IPlaceholderContentWidget GetPlaceholderContent(IMobileBlockInstanceWidget webBlockInstance, string placeholderName)
- IPlaceholderContentWidget GetPlaceholderContent(IWebBlockInstanceWidget webBlockInstance, string placeholderName)
- T GetSelfOrAncestorOfType<T>(IModelObject obj)
- SignatureInformation GetSignatureInformation(IESpace producer)
- T Into<T>(T node, IConnector connector, bool snapToGrid = False)
- bool IsConcrete(Type type)
- bool IsSignatureInterface(Type type)
- bool IsSignatureObject(IModelObject obj)
- T Labelled<T>(IEnumerable<T> items, string label)
- T Named<T>(IEnumerable<T> items, string name)
- void RefreshDependenciesUsingSignatureBinary(IESpace consumer, IESpace producer, bool updateSpecificVersion = False)
- IArgument SetArgumentValue(IEnumerable<IArgument> arguments, IInputParameterSignature parameter, ExpressionDefinition value)
- IAIArgument SetArgumentValue(IEnumerable<IAIArgument> arguments, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ILifeCycleDatabaseEvent obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IAIArgument SetArgumentValue(IActionHandler obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IAIArgument SetArgumentValue(IToolReference obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IExecuteClientActionNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IExecuteServerActionNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IRefreshDataNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IJavaScriptNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ISQLNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IDestinationNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ITriggerNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ITriggerGlobalNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ICallAgentNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ICallAgentManifestNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IEventHandler obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IWebBlockInstanceWidget obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IBuiltinEvent obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IEvent obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IBuiltinEvent obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IUILifeCycleEvent obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IMobileBlockInstanceWidget obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ITimer obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IGlobalEventHandler obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IExecuteProcessNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IHumanActivityNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ISendEmailNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IActivityDataItem obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(IAutomaticActivityNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- IArgument SetArgumentValue(ICallWorkflowNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- void SetAttributeMapping(ITypeConversionExpression typeConv, IAttributeSignature targetAttribute, ExpressionDefinition value)
- void SetAttributeValue(IRecord record, IEntityAttribute attribute, ExpressionDefinition value)
- IRecordLiteralField SetField(IRecordLiteralExpression expression, IAttributeSignature attribute, ExpressionDefinition value)
- IRecordLiteralField SetField(IRecordLiteralExpression expression, string fieldName, ExpressionDefinition value)
- IArgument SetScreenArgumentValue(IHumanActivityNode obj, IInputParameterSignature parameter, ExpressionDefinition value)
- T SnapToGrid<T>(T node)
- void SubstituteAndSimplify(IExpression expr, ValueTuple<IObjectSignature, object>[] substitutions)
- Func<IKey, Task<SignatureInformation>> ToAsync(Func<IKey, SignatureInformation> syncFunc)
- T ToTheLeftOf<T>(T node, IFlowNode referenceNode, bool snapToGrid = False)
- T ToTheLeftOf<T>(T node, IFlowNode referenceNode, int separation, bool snapToGrid = False)
- T ToTheRightOf<T>(T node, IFlowNode referenceNode, bool snapToGrid = False)
- T ToTheRightOf<T>(T node, IFlowNode referenceNode, int separation, bool snapToGrid = False)
- T TryCreateElement<T>(IChildCollection collection, IModelObject parent, object[] arguments)
- T TryCreateElement<T>(IChildCollection collection, IModelObject parent, string name = null, IKey key = null)
- IModelObject TryCreateElement(IChildCollection collection, IModelObject parent, object[] arguments, Type childType = null)
- IEnumerable<IWidget> TryGetContiguousWidgets(IEnumerable<IWidget> widgets)

### class ModelFeatureToggle
- bool? Server { get; set; }
- bool? Studio { get; set; }

### enum ModuleOperations
- None
- Load
- Clone
- All

### class PluginService : IPluginService
- void StandaloneInitialize()

### enum RuntimeMajor
- NET6
- NET7
- NET8
- NET10

### static class Services
- IModelServices ModelServices { get; }

### enum Spacing
- NotDefined
- Smaller
- Normal
- Larger

### class StyleProperties
- string BackgroundColor { get; set; }
- Border BorderRadius { get; set; }
- bool CanUseFontAsLocalResource { get; set; }
- FontFamily Font { get; set; }
- string FontColor { get; set; }
- string FontFamilyBoldResource { get; set; }
- string FontFamilyRegularResource { get; set; }
- double FontSize { get; set; }
- bool HasNativeLookAndFeel { get; set; }
- bool HasShadow { get; set; }
- string HeaderColor { get; set; }
- double HeaderSize { get; set; }
- bool IsDarkBackground { get; set; }
- bool IsDarkHeader { get; set; }
- bool IsDarkLoginBackground { get; set; }
- bool IsDarkPrimary { get; set; }
- bool IsDarkSecondary { get; set; }
- string LoginBackgroundColor { get; set; }
- string LoginBackgroundGradient { get; set; }
- string LoginBackgroundImagePath { get; set; }
- string PrimaryColor { get; set; }
- string PrimaryHover { get; set; }
- string PrimarySelected { get; set; }
- string SecondaryColor { get; set; }
- Spacing Spacing { get; set; }

### static class StylePropertiesHelper
- string GetDisplayValue(FontFamily font)
- string GetFontUnicodeRange(FontFamily font)
- string GetFontURL(FontFamily font)
- string GetFontWeight(FontFamily font, bool isRegular)
- string GetGenericFamily(FontFamily font)

### static class SystemObjectsKeys

### class UnrecoverableModelException : Exception, ISerializable

### enum ValidationMessageType
- Info
- Warning
- Error

## OutSystems.Model.Applications

### enum ElementKind
- Unknown
- Entity
- ClientEntity
- StaticEntity
- HiddenEntity
- Structure
- Action
- ServiceAPIMethod
- ClientAction
- WebBlock
- WebFlow
- ActionFolder
- ClientActionFolder
- Role
- Image
- Theme
- Script
- Resource
- ExtensionContent
- Process
- WebScreen
- HumanActivity
- WaitActivity
- ConditionalStart
- FlowExceptionHandlingFlow

### interface IApplication : IDisposable, IModelObject
- string ActivationCode { get; }
- IKey ApplicationKey { get; }
- IEnumerable<IReferencedApplication> Dependencies { get; }
- string Description { get; set; }
- IApplicationDescriptor Descriptor { get; }
- IKey FrontOfficeEspaceKey { get; set; }
- Byte[] Icon { get; set; }
- SegmentationKind Kind { get; }
- Version LastUpgradeVersion { get; }
- IEnumerable<IModuleBytes> Modules { get; }
- string Name { get; set; }
- ISolution Parent { get; }
- string PrimaryColor { get; set; }
- string Url { get; set; }
- Version Version { get; }
- void Add(IModule module)
- IESpace CreateBlankESpace(SegmentationKind eSpaceKind, string name = null, string activationCode = null, bool isTemplatesBundleESpace = False, IKey key = null, PlatformServerVersion targetPlatform = O11, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict, bool trackChanges = False)
- IESpace CreateESpaceFromTemplate(IESpace template, string name = null, string activationCode = null, string secretKey = null, IKey key = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace CreateESpaceFromTemplate(Byte[] templateOml, string name = null, string activationCode = null, string secretKey = null, string productKey = null, IKey key = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IESpace CreateESpaceFromTemplate(string templateOmlPath, string name = null, string activationCode = null, string secretKey = null, string productKey = null, IKey key = null, CreatedByTool tool = Unspecified, string developerId = null, CommitStrategy commitStrategy = ReexecuteOnConflict)
- IExtension CreateExtension(string name = null, string activationCode = null, IKey key = null, FileStorageStrategy resourceStorageStrategy = InMemory)
- void RemoveModule(IKey moduleKey)
- Byte[] Save()
- void Save(string path)
- Byte[] SaveAndDispose()
- void SaveAndDispose(string path)

### interface IApplicationDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty FrontOfficeEspaceKeyProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection<IApplication, IModuleBytes> ModulesChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty PrimaryColorProperty { get; }
- IProperty UrlProperty { get; }

### interface IModule : IDisposable, IModelObject
- string ActivationCode { get; }
- string Description { get; set; }
- string Digest { get; }
- Guid DigestBeforeUpgrades { get; }
- string Name { get; set; }
- Version Version { get; }
- Byte[] Save()
- void Save(string path)

### interface IModuleBytes : IDisposable, IModelObject
- Byte[] Content { get; }
- IModuleBytesDescriptor Descriptor { get; }
- bool IsLoaded { get; }
- ModuleKind Kind { get; }
- string Name { get; }
- bool IsModuleOperationAllowed(ModuleOperations operations)
- bool IsModuleOperationAllowed(ModuleOperations operations, string secretKey)
- IModule Load(string secretKey = null, FileStorageStrategy resourceStorageStrategy = InMemory)

### interface IModuleBytesDescriptor : IClassDescriptor
- IChildCollection<IModuleBytes, IModule> ModuleChildCollection { get; }
- IProperty NameProperty { get; }

### interface IModuleDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface IReferencedApplication
- Version ForgeBaseVersion { get; }
- IKey Key { get; }
- SegmentationKind Kind { get; }
- IEnumerable<IReferencedModule> Modules { get; }
- string Name { get; }

### interface IReferencedElement
- Guid CompatibilitySignatureHash { get; }
- Guid FullSignatureHash { get; }
- IKey Key { get; }
- ElementKind Kind { get; }
- string Name { get; }

### interface IReferencedModule
- IEnumerable<IReferencedElement> Elements { get; }
- IKey Key { get; }
- ModuleKind Kind { get; }

### interface ISolution : IDisposable, IModelObject
- string ActivationCode { get; }
- IEnumerable<IModuleBytes> AddedModules { get; }
- IEnumerable<IApplication> Applications { get; }
- string Description { get; set; }
- ISolutionDescriptor Descriptor { get; }
- IEnumerable<IKey> ExcludedModules { get; }
- bool IsTransient { get; }
- Version LastUpgradeVersion { get; }
- IEnumerable<IModuleBytes> Modules { get; }
- string Name { get; set; }
- IKey SolutionKey { get; }
- Version Version { get; }
- string VersionName { get; set; }
- void Add(IModule module)
- void Add(IApplication app)
- void RemoveApplication(IKey appKey)
- void RemoveModule(IKey moduleKey)
- Byte[] Save()
- void Save(string path)
- Byte[] SaveAndDispose()
- void SaveAndDispose(string path)

### interface ISolutionDescriptor : IClassDescriptor
- IChildCollection<ISolution, IApplication> ApplicationsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection<ISolution, IModuleBytes> ModulesChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty VersionNameProperty { get; }

### enum ModuleKind
- eSpace
- Extension

## OutSystems.Model.BusinessProcesses

### interface IActivityDataItem : IObjectSignature
- IServiceActionSignature Action { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- IActivityDataItemDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IActivityDataItemDescriptor : IObjectSignatureDescriptor
- IProperty ActionProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IBusinessProcess : IBusinessProcessSignature, IFlow, IShareableESpaceObject<IBusinessProcess, IBusinessProcessSignature>
- string CreatedBy { get; set; }
- IEnumerable<IEnumerable<IBusinessProcessConnector>> CyclicConnectorsClusters { get; }
- string Description { get; set; }
- IBusinessProcessDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<IBusinessProcessNode> Nodes { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IBusinessProcessNode CreateNode(Type type, string name = null, IKey key = null)

### interface IBusinessProcessConnector : IConnector
- IBusinessProcessConnectorDescriptor Descriptor { get; }
- IBusinessProcessNode Source { get; }
- IBusinessProcessNode Target { get; set; }

### interface IBusinessProcessConnectorDescriptor : IConnectorDescriptor

### interface IBusinessProcessDescriptor : IBusinessProcessSignatureDescriptor, IFlowDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection NodesChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IBusinessProcessSignature : IFlowSignature
- string CreatedBy { get; }
- string Description { get; }
- IBusinessProcessSignatureDescriptor Descriptor { get; }
- Byte[] Icon { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IBusinessProcessSignatureDescriptor : IFlowSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IOutcome : IBusinessProcessConnector
- IOutcomeDescriptor Descriptor { get; }
- string Label { get; set; }
- IExpression Value { get; }
- void SetValue(ExpressionDefinition value)

### interface IOutcomeDescriptor : IBusinessProcessConnectorDescriptor
- IProperty LabelProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface IPath : IBusinessProcessConnector
- IPathDescriptor Descriptor { get; }
- string Label { get; set; }

### interface IPathDescriptor : IBusinessProcessConnectorDescriptor
- IProperty LabelProperty { get; }

## OutSystems.Model.BusinessProcesses.Nodes

### interface AbstractProcessNode : IBusinessProcessNodeWithLabelAndDescription

### interface IAutomaticActivityNode : IBusinessProcessNode
- IServiceActionSignature ActionToTrigger { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- string Description { get; set; }
- IAutomaticActivityNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- IBusinessProcessNode Target { get; set; }

### interface IAutomaticActivityNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty ActionToTriggerProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty TargetProperty { get; }

### interface IBusinessProcessNode : IFlowNode
- IEnumerable<IBusinessProcessConnector> Connectors { get; }
- IBusinessProcessNodeDescriptor Descriptor { get; }
- IEnumerable<IBusinessProcessConnector> IncomingConnectors { get; }

### interface IBusinessProcessNodeDescriptor : IFlowNodeDescriptor

### interface IBusinessProcessNodeWithLabelAndDescription
- string Description { get; set; }
- string Label { get; set; }

### interface ICallWorkflowNode : IBusinessProcessNode
- IEnumerable<IArgument> Arguments { get; }
- string Description { get; set; }
- ICallWorkflowNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- IBusinessProcessSignature StartsProcess { get; set; }
- IBusinessProcessNode Target { get; set; }

### interface ICallWorkflowNodeDescriptor : IBusinessProcessNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty StartsProcessProperty { get; }
- IProperty TargetProperty { get; }

### interface ICommentConnector : IBusinessProcessConnector
- ICommentConnectorDescriptor Descriptor { get; }
- string Label { get; set; }

### interface ICommentConnectorDescriptor : IBusinessProcessConnectorDescriptor
- IProperty LabelProperty { get; }

### interface ICommentNode : IBusinessProcessNode
- string Comment { get; set; }
- IEnumerable<ICommentConnector> Connectors { get; }
- string CreatedBy { get; set; }
- ICommentNodeDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ICommentConnector CreateConnector(IBusinessProcessNode target)

### interface ICommentNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty CommentProperty { get; }
- IChildCollection ConnectorsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IConditionalStartNode : IBusinessProcessNode
- ISequence<IEventCondition> Conditions { get; }
- string Description { get; set; }
- IConditionalStartNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- IGlobalEventSignature StartFlowOn { get; set; }
- IBusinessProcessNode Target { get; set; }
- IEventCondition CreateCondition(ExpressionDefinition condition)

### interface IConditionalStartNodeDescriptor : IBusinessProcessNodeDescriptor
- IChildCollection ConditionsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty StartFlowOnProperty { get; }
- IProperty TargetProperty { get; }

### interface IDecisionNode : IBusinessProcessNode
- IEnumerable<IActivityDataItem> ActivityData { get; }
- string Description { get; set; }
- IDecisionNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IOutcome Otherwise { get; }
- ISequence<IOutcome> Outcomes { get; }
- IForkNode ParentParallelNode { get; }
- IActivityDataItem AddAction(IServiceActionSignature action)
- IOutcome CreateOutcome()

### interface IDecisionNodeDescriptor : IBusinessProcessNodeDescriptor
- IChildCollection ActivityDataChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutcomesChildCollection { get; }
- IProperty ParentParallelNodeProperty { get; }

### interface IEndNode : IBusinessProcessNode
- string Description { get; set; }
- IEndNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IForkNode ParentParallelNode { get; }

### interface IEndNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty ParentParallelNodeProperty { get; }

### interface IEventCondition : IObject
- IEventConditionDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IEventConditionDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IForkNode : IBusinessProcessNode
- string Description { get; set; }
- IForkNodeDescriptor Descriptor { get; }
- IJoinNode JoinNode { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- ISequence<IPath> Paths { get; }
- IPath CreatePath()

### interface IForkNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty JoinNodeProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IChildCollection PathsChildCollection { get; }

### interface IGoToNode : IBusinessProcessNode
- string Description { get; set; }
- IGoToNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IForkNode ParentParallelNode { get; }
- IBusinessProcessNode Target { get; set; }

### interface IGoToNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty TargetProperty { get; }

### interface IHumanActivityNode : IBusinessProcessNode
- IEnumerable<IActivityDataItem> ActivityData { get; }
- AssignMode AssignMode { get; set; }
- IExpression AssignTo { get; }
- IGlobalEventSignature CloseOn { get; set; }
- ISequence<IEventCondition> CloseOnConditions { get; }
- string Description { get; set; }
- IHumanActivityNodeDescriptor Descriptor { get; }
- IMobileScreenSignature DestinationScreen { get; set; }
- IExpression DisplayMessage { get; }
- string Label { get; set; }
- string Name { get; set; }
- IGlobalEventSignature OpenOn { get; set; }
- ISequence<IEventCondition> OpenOnConditions { get; }
- IForkNode ParentParallelNode { get; }
- IGlobalEventSignature ReassignOn { get; set; }
- ISequence<IEventCondition> ReassignOnConditions { get; }
- IGlobalEventSignature ReleaseOn { get; set; }
- ISequence<IEventCondition> ReleaseOnConditions { get; }
- ICollection<IRoleSignature> Roles { get; }
- IEnumerable<IArgument> ScreenArguments { get; }
- IBusinessProcessNode Target { get; set; }
- int? TimeoutBasicTime { get; set; }
- IExpression TimeoutCustomTime { get; }
- TimeoutMode TimeoutMode { get; set; }
- TimeUnit TimeoutUnit { get; set; }
- IActivityDataItem AddAction(IServiceActionSignature action)
- IEventCondition CreateCloseOnCondition(ExpressionDefinition condition)
- IEventCondition CreateOpenOnCondition(ExpressionDefinition condition)
- IEventCondition CreateReAssignOnCondition(ExpressionDefinition condition)
- IEventCondition CreateReleaseOnCondition(ExpressionDefinition condition)
- void SetAssignTo(ExpressionDefinition value)
- void SetDisplayMessage(ExpressionDefinition value)
- void SetTimeoutCustomTime(ExpressionDefinition value)

### interface IHumanActivityNodeDescriptor : IBusinessProcessNodeDescriptor
- IChildCollection ActivityDataChildCollection { get; }
- IProperty AssignModeProperty { get; }
- IExpressionProperty AssignToProperty { get; }
- IChildCollection CloseOnConditionsChildCollection { get; }
- IProperty CloseOnProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty DestinationScreenProperty { get; }
- IExpressionProperty DisplayMessageProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OpenOnConditionsChildCollection { get; }
- IProperty OpenOnProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IChildCollection ReassignOnConditionsChildCollection { get; }
- IProperty ReassignOnProperty { get; }
- IChildCollection ReleaseOnConditionsChildCollection { get; }
- IProperty ReleaseOnProperty { get; }
- IProperty RolesProperty { get; }
- IChildCollection ScreenArgumentsChildCollection { get; }
- IProperty TargetProperty { get; }
- IProperty TimeoutBasicTimeProperty { get; }
- IExpressionProperty TimeoutCustomTimeProperty { get; }
- IProperty TimeoutModeProperty { get; }
- IProperty TimeoutUnitProperty { get; }

### interface IJoinNode : IBusinessProcessNode
- string Description { get; set; }
- IJoinNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParallelNode { get; }
- IForkNode ParentParallelNode { get; }
- IBusinessProcessNode Target { get; set; }

### interface IJoinNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParallelNodeProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty TargetProperty { get; }

### interface IStartNode : IBusinessProcessNode
- string Description { get; set; }
- IStartNodeDescriptor Descriptor { get; }
- Frequency Frequency { get; set; }
- IExpression InstanceLabel { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- ISchedule ScheduleConfiguration { get; }
- IGlobalEventSignature StartProcessOn { get; set; }
- IBusinessProcessNode Target { get; set; }
- TriggerMode TriggerMode { get; set; }
- void SetInstanceLabel(ExpressionDefinition value)

### interface IStartNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty FrequencyProperty { get; }
- IExpressionProperty InstanceLabelProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IChildCollection ScheduleConfigurationChildCollection { get; }
- IProperty StartProcessOnProperty { get; }
- IProperty TargetProperty { get; }
- IProperty TriggerModeProperty { get; }

### interface ITerminateNode : IBusinessProcessNode
- string Description { get; set; }
- ITerminateNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IForkNode ParentParallelNode { get; }

### interface ITerminateNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty ParentParallelNodeProperty { get; }

### interface IWaitActivityNode : IBusinessProcessNode
- IGlobalEventSignature CloseOnEvent { get; set; }
- ISequence<IEventCondition> Conditions { get; }
- string Description { get; set; }
- IWaitActivityNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IForkNode ParentParallelNode { get; }
- IBusinessProcessNode Target { get; set; }
- int? TimeoutBasicTime { get; set; }
- IExpression TimeoutCustomTime { get; }
- TimeoutMode TimeoutMode { get; set; }
- TimeUnit TimeoutUnit { get; set; }
- IEventCondition CreateCondition(ExpressionDefinition condition)
- void SetTimeoutCustomTime(ExpressionDefinition value)

### interface IWaitActivityNodeDescriptor : IBusinessProcessNodeDescriptor
- IProperty CloseOnEventProperty { get; }
- IChildCollection ConditionsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ParentParallelNodeProperty { get; }
- IProperty TargetProperty { get; }
- IProperty TimeoutBasicTimeProperty { get; }
- IExpressionProperty TimeoutCustomTimeProperty { get; }
- IProperty TimeoutModeProperty { get; }
- IProperty TimeoutUnitProperty { get; }

## OutSystems.Model.CompoundKeys

### interface ICompoundKey : IEquatable<ICompoundKey>

## OutSystems.Model.Data

### enum EntityKind
- Server
- Client
- Static

### interface IClientEntity : IClientEntitySignature, IEntity, IShareableESpaceObject<IClientEntity, IClientEntitySignature>
- IClientEntityDescriptor Descriptor { get; }
- bool ExposeReadOnly { get; set; }
- IRecord SampleRecord { get; }
- string TableNameOverride { get; set; }
- string ViewNameOverride { get; set; }

### interface IClientEntityDescriptor : IClientEntitySignatureDescriptor, IEntityDescriptor
- IProperty TableNameOverrideProperty { get; }
- IProperty ViewNameOverrideProperty { get; }

### interface IClientEntitySignature : IEntitySignature
- IEntityActionSignature CreateAction { get; }
- IEntityActionSignature CreateOrUpdateAction { get; }
- IEntityActionSignature CreateOrUpdateAllAction { get; }
- IEntityActionSignature DeleteAction { get; }
- IEntityActionSignature DeleteAllAction { get; }
- IClientEntitySignatureDescriptor Descriptor { get; }
- IRecordSignature SampleRecord { get; }
- IEntityActionSignature UpdateAction { get; }

### interface IClientEntitySignatureDescriptor : IEntitySignatureDescriptor
- IChildCollection SampleRecordChildCollection { get; }

### interface IClientVariable : IObject
- string CreatedBy { get; set; }
- ITypeSignature DataType { get; set; }
- IExpression DefaultValue { get; }
- string Description { get; set; }
- IClientVariableDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetDefaultValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IClientVariableDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IEntity : IEntitySignature, IRecordType, IShareableESpaceObject<IEntity, IEntitySignature>
- ISequence<IEntityAttribute> Attributes { get; }
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IEntityDescriptor Descriptor { get; }
- bool ExposeProcessEvents { get; set; }
- bool ExposeReadOnly { get; set; }
- IFolder Folder { get; set; }
- IEntityAttributeSignature IdentifierAttribute { get; set; }
- IEntityAttributeSignature IsActiveAttribute { get; set; }
- BooleanWithInheritance IsMultiTenant { get; set; }
- bool IsRestrictedInQueries { get; set; }
- string Label { get; set; }
- IEntityAttributeSignature LabelAttribute { get; set; }
- string LabelPlural { get; set; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- IEntityAttributeSignature OrderByAttribute { get; set; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- bool ShowTenantIdentifier { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- UpdateEntityBehaviorType UpdateBehavior { get; set; }
- bool UseTranslations { get; set; }
- IEntity ConvertTo(EntityKind targetKind)
- IEntityAttribute CreateAttribute(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IEntityAttribute : IAttribute, IEntityAttributeSignature
- ISearchableAttribute AsSearchable { get; }
- IBasicType DataType { get; set; }
- DeleteRule DeleteRule { get; set; }
- IEntityAttributeDescriptor Descriptor { get; }
- AutoNumber IsAutoNumber { get; set; }
- bool IsSearchable { get; set; }
- string Label { get; set; }
- string OriginalName { get; set; }
- string OriginalType { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IEntityAttributeDescriptor : IAttributeDescriptor, IEntityAttributeSignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IEntityAttributeSignature : IAttributeSignature
- ISearchableAttributeSignature AsSearchable { get; }
- IBasicType DataType { get; }
- DeleteRule DeleteRule { get; }
- IEntityAttributeSignatureDescriptor Descriptor { get; }
- AutoNumber IsAutoNumber { get; }
- bool IsSearchable { get; }
- string Label { get; }
- string OriginalName { get; }
- string OriginalType { get; }

### interface IEntityAttributeSignatureDescriptor : IAttributeSignatureDescriptor
- IProperty DeleteRuleProperty { get; }
- IProperty IsAutoNumberProperty { get; }
- IProperty IsSearchableProperty { get; }
- IProperty LabelProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalTypeProperty { get; }

### interface IEntityConnector : IConnector
- IEntityAttributeSignature Attribute { get; }
- IEntityConnectorDescriptor Descriptor { get; }

### interface IEntityConnectorDescriptor : IConnectorDescriptor
- IProperty AttributeProperty { get; }

### interface IEntityDescriptor : IEntitySignatureDescriptor, IRecordTypeDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IEntityDiagram : IFlow
- IEntityDiagramDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- IEnumerable<IEntityDiagramNode> Nodes { get; }
- IEntityDiagramNode CreateNode(IEntitySignature entity)
- T CreateNode<T>(string name = null, IKey key = null)
- IEntityDiagramNode CreateNode(Type type, string name = null, IKey key = null)

### interface IEntityDiagramDescriptor : IFlowDescriptor
- IProperty FolderProperty { get; }
- IChildCollection NodesChildCollection { get; }

### interface IEntityIndex : IEntityIndexSignature, IObject
- bool AutoGenerated { get; set; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- IEntityIndexDescriptor Descriptor { get; }
- ISequence<IEntityIndexAttribute> IndexAttributes { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Name { get; set; }
- bool Unique { get; set; }
- void AddAttribute(IEntityAttribute attribute)

### interface IEntityIndexAttribute : IEntityIndexAttributeSignature, IObject
- IEntityAttribute Attribute { get; set; }
- IEntityIndexAttributeDescriptor Descriptor { get; }

### interface IEntityIndexAttributeDescriptor : IEntityIndexAttributeSignatureDescriptor, IObjectDescriptor

### interface IEntityIndexAttributeSignature : IObjectSignature
- IEntityAttributeSignature Attribute { get; }
- IEntityIndexAttributeSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IEntityIndexAttributeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty AttributeProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface IEntityIndexDescriptor : IEntityIndexSignatureDescriptor, IObjectDescriptor
- IProperty AutoGeneratedProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IEntityIndexSignature : IObjectSignature
- string Description { get; }
- IEntityIndexSignatureDescriptor Descriptor { get; }
- IEnumerable<IEntityIndexAttributeSignature> IndexAttributes { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- bool Unique { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IEntityIndexSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IChildCollection IndexAttributesChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty UniqueProperty { get; }

### interface IEntitySignature : IDataSource, IRecordTypeSignature
- IEnumerable<IEntityAttributeSignature> Attributes { get; }
- string CreatedBy { get; }
- string Description { get; }
- IEntitySignatureDescriptor Descriptor { get; }
- EntityKind EntityKind { get; }
- bool ExposeProcessEvents { get; }
- bool ExposeReadOnly { get; }
- IFolderSignature Folder { get; }
- IEntityActionSignature GetAction { get; }
- bool Hidden { get; }
- IEntityAttributeSignature IdentifierAttribute { get; }
- IIdentifierType IdentifierType { get; }
- IEntityAttributeSignature IsActiveAttribute { get; }
- BooleanWithInheritance IsMultiTenant { get; }
- bool IsRestrictedInQueries { get; }
- string Label { get; }
- IEntityAttributeSignature LabelAttribute { get; }
- string LabelPlural { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEntityAttributeSignature OrderByAttribute { get; }
- bool ShowTenantIdentifier { get; }
- UpdateEntityBehaviorType UpdateBehavior { get; }
- bool UseTranslations { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IEntitySignatureDescriptor : IRecordTypeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection<IEntitySignature, IEntityActionSignature> EntityActionsChildCollection { get; }
- IProperty ExposeProcessEventsProperty { get; }
- IProperty ExposeReadOnlyProperty { get; }
- IProperty FolderProperty { get; }
- IProperty HiddenProperty { get; }
- IProperty IdentifierAttributeProperty { get; }
- IChildCollection IdentifierTypeChildCollection { get; }
- IProperty IsActiveAttributeProperty { get; }
- IProperty IsMultiTenantProperty { get; }
- IProperty IsRestrictedInQueriesProperty { get; }
- IProperty LabelAttributeProperty { get; }
- IProperty LabelPluralProperty { get; }
- IProperty LabelProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty OrderByAttributeProperty { get; }
- IProperty ShowTenantIdentifierProperty { get; }
- IProperty UpdateBehaviorProperty { get; }
- IProperty UseTranslationsProperty { get; }

### interface IEntityVersion : IObject
- IEntityVersionDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IEntityVersionDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }

### interface IExtensibilitySetting : IObject
- string CreatedBy { get; set; }
- IBasicType DataType { get; set; }
- IExpression DefaultValue { get; }
- string Description { get; set; }
- IExtensibilitySettingDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }
- bool IsSecret { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetDefaultValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IExtensibilitySettingDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty IsSecretProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ILifeCycleDatabaseEvent : IObject
- IEnumerable<IArgument> Arguments { get; }
- ILifeCycleDatabaseEventDescriptor Descriptor { get; }
- IGlobalEvent Destination { get; set; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface ILifeCycleDatabaseEventDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DestinationProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface ILocale : IObject
- Culture Culture { get; }
- ILocaleDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface ILocaleDescriptor : IObjectDescriptor
- IProperty CultureProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface IOnCreateLifeCycleDatabaseEvent : ILifeCycleDatabaseEvent
- IOnCreateLifeCycleDatabaseEventDescriptor Descriptor { get; }

### interface IOnCreateLifeCycleDatabaseEventDescriptor : ILifeCycleDatabaseEventDescriptor

### interface IOnDeleteLifeCycleDatabaseEvent : ILifeCycleDatabaseEvent
- IOnDeleteLifeCycleDatabaseEventDescriptor Descriptor { get; }

### interface IOnDeleteLifeCycleDatabaseEventDescriptor : ILifeCycleDatabaseEventDescriptor

### interface IOnUpdateLifeCycleDatabaseEvent : ILifeCycleDatabaseEvent
- IOnUpdateLifeCycleDatabaseEventDescriptor Descriptor { get; }

### interface IOnUpdateLifeCycleDatabaseEventDescriptor : ILifeCycleDatabaseEventDescriptor

### interface IRecord : IObject, IRecordSignature
- IEnumerable<IRecordAttributeValue> AttributeValues { get; }
- IRecordDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IRecordAttributeValue : IObject, IRecordAttributeValueSignature
- IEntityAttribute Attribute { get; }
- IRecordAttributeValueDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IRecordAttributeValueDescriptor : IObjectDescriptor, IRecordAttributeValueSignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IRecordAttributeValueSignature : IObjectSignature
- IEntityAttributeSignature Attribute { get; }
- IRecordAttributeValueSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IRecordAttributeValueSignatureDescriptor : IObjectSignatureDescriptor
- IProperty AttributeProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IRecordDescriptor : IObjectDescriptor, IRecordSignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IRecordSignature : IObjectSignature
- IEnumerable<IRecordAttributeValueSignature> AttributeValues { get; }
- IRecordSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IRecordSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection AttributeValuesChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }

### interface IResource : IResourceSignature, IShareableESpaceObject<IResource, IResourceSignature>
- string CreatedBy { get; set; }
- DeployAction DeployAction { get; set; }
- string Description { get; set; }
- IResourceDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- string TargetDirectory { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IResourceDescriptor : IObjectDescriptor, IResourceSignatureDescriptor
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IResourceSignature : IObjectSignature
- string CreatedBy { get; }
- DeployAction DeployAction { get; }
- string Description { get; }
- IResourceSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- Byte[] ResourceContent { get; }
- string RuntimePath { get; }
- string TargetDirectory { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IResourceSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DeployActionProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty ResourceContentProperty { get; }
- IProperty RuntimePathProperty { get; }
- IProperty TargetDirectoryProperty { get; }

### interface ISearchableAttribute : IEntityAttribute, ISearchableAttributeSignature
- ChunkingMethod? ChunkingMethod { get; set; }
- int ChunkOverlap { get; set; }
- int ChunkSize { get; set; }
- bool IsSearchable { get; set; }
- int SentencesPerChunk { get; set; }
- string Separators { get; set; }
- IChunkingMethod GetChunkingMethod()
- T SetChunkingMethod<T>()

### interface ISearchableAttributeSignature : IEntityAttributeSignature
- bool IsSearchable { get; }

### interface IServerEntity : IEntity, IServerEntitySignature, IShareableESpaceObject<IServerEntity, IServerEntitySignature>
- IServerEntityDescriptor Descriptor { get; }
- bool ExposeProcessEvents { get; set; }
- bool ExposeReadOnly { get; set; }
- IEnumerable<IEntityIndex> Indexes { get; }
- IEntityVersion NewVersion { get; }
- IEntityVersion OldVersion { get; }
- IOnCreateLifeCycleDatabaseEvent OnCreate { get; }
- IOnDeleteLifeCycleDatabaseEvent OnDelete { get; }
- IOnUpdateLifeCycleDatabaseEvent OnUpdate { get; }
- IRecord SampleRecord { get; }
- string TableNameOverride { get; set; }
- string ViewNameOverride { get; set; }
- IEntityIndex CreateIndex(string name = null)

### interface IServerEntityDescriptor : IEntityDescriptor, IServerEntitySignatureDescriptor
- IChildCollection NewVersionChildCollection { get; }
- IChildCollection OldVersionChildCollection { get; }
- IChildCollection OnCreateChildCollection { get; }
- IChildCollection OnDeleteChildCollection { get; }
- IChildCollection OnUpdateChildCollection { get; }
- IProperty TableNameOverrideProperty { get; }
- IProperty ViewNameOverrideProperty { get; }

### interface IServerEntitySignature : IEntitySignature
- IEntityActionSignature CreateAction { get; }
- IEntityActionSignature CreateOrUpdateAction { get; }
- IEntityActionSignature CreateOrUpdateAllAction { get; }
- IEntityActionSignature DeleteAction { get; }
- IEntityActionSignature DeleteAllAction { get; }
- IServerEntitySignatureDescriptor Descriptor { get; }
- IEntityActionSignature GetForUpdateAction { get; }
- IEnumerable<IEntityIndexSignature> Indexes { get; }
- IRecordSignature SampleRecord { get; }
- IEntityActionSignature UpdateAction { get; }

### interface IServerEntitySignatureDescriptor : IEntitySignatureDescriptor
- IChildCollection IndexesChildCollection { get; }
- IChildCollection SampleRecordChildCollection { get; }

### interface ISessionVariable : IObject
- string CreatedBy { get; set; }
- ITypeSignature DataType { get; set; }
- IExpression DefaultValue { get; }
- string Description { get; set; }
- ISessionVariableDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool IsReadOnly { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetDefaultValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISessionVariableDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IsReadOnlyProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ISiteProperty : IObject
- string CreatedBy { get; set; }
- IBasicType DataType { get; set; }
- IExpression DefaultValue { get; }
- string Description { get; set; }
- ISitePropertyDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- BooleanWithInheritance IsMultiTenant { get; set; }
- bool IsReadOnly { get; }
- bool IsSecret { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetDefaultValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISitePropertyDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DataTypeProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IsMultiTenantProperty { get; }
- IProperty IsReadOnlyProperty { get; }
- IProperty IsSecretProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IStaticEntity : IEntity, IShareableESpaceObject<IStaticEntity, IStaticEntitySignature>, IStaticEntitySignature
- IStaticEntityDescriptor Descriptor { get; }
- IEnumerable<IStaticEntityRecord> Records { get; }
- bool UseTranslations { get; set; }
- IStaticEntityRecord CreateRecord(string name = null, IKey key = null)

### interface IStaticEntityDescriptor : IEntityDescriptor, IStaticEntitySignatureDescriptor

### interface IStaticEntityRecord : IRecord, IStaticEntityRecordSignature
- string CreatedBy { get; set; }
- IStaticEntityRecordDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- string Identifier { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }

### interface IStaticEntityRecordDescriptor : IRecordDescriptor, IStaticEntityRecordSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IStaticEntityRecordSignature : IRecordSignature
- IStaticEntityRecordSignatureDescriptor Descriptor { get; }
- Byte[] Icon { get; }
- string Identifier { get; }

### interface IStaticEntityRecordSignatureDescriptor : IRecordSignatureDescriptor
- IProperty IconProperty { get; }
- IProperty IdentifierProperty { get; }

### interface IStaticEntitySignature : IEntitySignature
- IStaticEntitySignatureDescriptor Descriptor { get; }
- IEnumerable<IStaticEntityRecordSignature> Records { get; }

### interface IStaticEntitySignatureDescriptor : IEntitySignatureDescriptor
- IChildCollection RecordsChildCollection { get; }

### interface IStructure : IRecordType, IShareableESpaceObject<IStructure, IStructureSignature>, IStructureSignature
- ISequence<IStructureAttribute> Attributes { get; }
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IStructureDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool IsReadOnly { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IStructureAttribute CreateAttribute(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IStructureAttribute : IAttribute, IStructureAttributeSignature
- string CreatedBy { get; set; }
- IStructureAttributeDescriptor Descriptor { get; }
- string Label { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string NameInJSON { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IStructureAttributeDescriptor : IAttributeDescriptor, IStructureAttributeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IStructureAttributeSignature : IAttributeSignature
- IStructureAttributeSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; }
- string Label { get; }
- string NameInJSON { get; }

### interface IStructureAttributeSignatureDescriptor : IAttributeSignatureDescriptor
- IProperty LabelProperty { get; }
- IProperty NameInJSONProperty { get; }

### interface IStructureDescriptor : IRecordTypeDescriptor, IStructureSignatureDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IStructureSignature : IDataSource, IRecordTypeSignature
- IEnumerable<IStructureAttributeSignature> Attributes { get; }
- string CreatedBy { get; }
- string Description { get; }
- IStructureSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- string IntegrationName { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IStructureSignatureDescriptor : IRecordTypeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface ISystemStaticEntity : IStaticEntitySignature

## OutSystems.Model.Data.ChunkingMethods

### interface IByPageChunkingMethod : IChunkSizeChunkingMethod

### interface IByParagraphChunkingMethod : IChunkSizeChunkingMethod

### interface IBySectionHeaderChunkingMethod : IChunkSizeChunkingMethod

### interface IChunkingMethod
- ChunkingMethod MethodKind { get; }

### interface IChunkSizeChunkingMethod : IChunkingMethod
- int ChunkSize { get; set; }

### interface IFixedSizeChunkingMethod : IChunkSizeChunkingMethod
- int ChunkOverlap { get; set; }

### interface INoneChunkingMethod : IChunkingMethod

### interface IRecursiveChunkingMethod : IFixedSizeChunkingMethod
- string Separators { get; set; }

### interface ISentenceBasedChunkingMethod : IFixedSizeChunkingMethod
- int SentencesPerChunk { get; set; }

### interface ISmartChunkingMethod : IChunkingMethod

## OutSystems.Model.Data.Nodes

### interface IEntityDiagramNode : IFlowNode
- IEntityDiagramNodeDescriptor Descriptor { get; }
- IRecordTypeSignature Entity { get; set; }
- IEnumerable<IEntityConnector> Relationships { get; }

### interface IEntityDiagramNodeDescriptor : IFlowNodeDescriptor
- IProperty EntityProperty { get; }

## OutSystems.Model.Enumerations

### enum ActivityInputType
- YesMandatory
- YesOptional
- No

### enum AgentManifestCallType
- Sync
- Async

### enum AggregationType
- None
- Sum
- Avg
- Max
- Min
- Count

### enum AjaxRefreshAnimationEffectType
- None
- Highlight
- Fade
- VerticalSlide

### enum Align
- Null
- Left
- Center
- Right

### enum AlignItems
- Stretch
- Start
- Center
- End

### enum AlignSelf
- Auto
- Start
- Center
- End
- Stretch
- Baseline

### enum AssignMode
- User
- Roles

### enum AutoNumber
- No
- Yes
- YesIfEmpty

### enum BooleanWithInheritance
- Inherited
- No
- Yes

### enum ChunkingMethod
- Smart
- FixedSize
- SentenceBased
- Recursive
- ByPage
- ByParagraph
- BySectionHeader
- None

### enum CreatedByTool
- Unspecified
- ServiceStudio
- IntegrationStudio
- IntegrationBuilder
- AppEditor
- AppGenerator
- ODCStudio
- O11ToODCMigrationTool
- WorkflowEditor
- ODCStudioMentor
- MentorWorkspace
- AgentExperience

### enum Culture
- AA
- AA_DJ
- AA_ER
- AA_ET
- AF
- AF_NA
- AF_ZA
- AGQ
- AGQ_CM
- AK
- AK_GH
- AM
- AM_ET
- AR
- ARN
- ARN_CL
- AR_001
- AR_AE
- AR_BH
- AR_DJ
- AR_DZ
- AR_EG
- AR_ER
- AR_IL
- AR_IQ
- AR_JO
- AR_KM
- AR_KW
- AR_LB
- AR_LY
- AR_MA
- AR_MR
- AR_OM
- AR_PS
- AR_QA
- AR_SA
- AR_SD
- AR_SO
- AR_SS
- AR_SY
- AR_TD
- AR_TN
- AR_YE
- AS
- ASA
- ASA_TZ
- AST
- AST_ES
- AS_IN
- AZ
- AZ_CYRL
- AZ_CYRL_AZ
- AZ_LATN
- AZ_LATN_AZ
- BA
- BAS
- BAS_CM
- BA_RU
- BE
- BEM
- BEM_ZM
- BEZ
- BEZ_TZ
- BE_BY
- BG
- BGC
- BGC_DEVA
- BGC_DEVA_IN
- BG_BG
- BHO
- BHO_DEVA
- BHO_DEVA_IN
- BIN
- BIN_NG
- BM
- BM_LATN
- BM_LATN_ML
- BM_ML
- BN
- BN_BD
- BN_IN
- BO
- BO_CN
- BO_IN
- BR
- BRX
- BRX_IN
- BR_FR
- BS
- BS_CYRL
- BS_CYRL_BA
- BS_LATN
- BS_LATN_BA
- BYN
- BYN_ER
- CA
- CA_AD
- CA_ES
- CA_ES_VALENCIA
- CA_FR
- CA_IT
- CCP
- CCP_BD
- CCP_CAKM
- CCP_CAKM_BD
- CCP_CAKM_IN
- CCP_IN
- CE
- CEB
- CEB_LATN
- CEB_LATN_PH
- CEB_PH
- CE_RU
- CGG
- CGG_UG
- CHR
- CHR_CHER
- CHR_CHER_US
- CHR_US
- CKB
- CKB_IQ
- CKB_IR
- CO
- CO_FR
- CS
- CS_CZ
- CU
- CU_RU
- CV
- CV_CYRL
- CV_CYRL_RU
- CY
- CY_GB
- DA
- DAV
- DAV_KE
- DA_DK
- DA_GL
- DE
- DE_AT
- DE_BE
- DE_CH
- DE_DE
- DE_IT
- DE_LI
- DE_LU
- DJE
- DJE_NE
- DOI
- DOI_DEVA
- DOI_DEVA_IN
- DSB
- DSB_DE
- DUA
- DUA_CM
- DV
- DV_MV
- DYO
- DYO_SN
- DZ
- DZ_BT
- EBU
- EBU_KE
- EE
- EE_GH
- EE_TG
- EL
- EL_CY
- EL_GR
- EN
- EN_001
- EN_029
- EN_150
- EN_AE
- EN_AG
- EN_AI
- EN_AS
- EN_AT
- EN_AU
- EN_BB
- EN_BE
- EN_BI
- EN_BM
- EN_BS
- EN_BW
- EN_BZ
- EN_CA
- EN_CC
- EN_CH
- EN_CK
- EN_CM
- EN_CX
- EN_CY
- EN_DE
- EN_DK
- EN_DM
- EN_ER
- EN_FI
- EN_FJ
- EN_FK
- EN_FM
- EN_GB
- EN_GD
- EN_GG
- EN_GH
- EN_GI
- EN_GM
- EN_GU
- EN_GY
- EN_HK
- EN_ID
- EN_IE
- EN_IL
- EN_IM
- EN_IN
- EN_IO
- EN_JE
- EN_JM
- EN_KE
- EN_KI
- EN_KN
- EN_KY
- EN_LC
- EN_LR
- EN_LS
- EN_MG
- EN_MH
- EN_MO
- EN_MP
- EN_MS
- EN_MT
- EN_MU
- EN_MV
- EN_MW
- EN_MY
- EN_NA
- EN_NF
- EN_NG
- EN_NL
- EN_NR
- EN_NU
- EN_NZ
- EN_PG
- EN_PH
- EN_PK
- EN_PN
- EN_PR
- EN_PW
- EN_RW
- EN_SB
- EN_SC
- EN_SD
- EN_SE
- EN_SG
- EN_SH
- EN_SI
- EN_SL
- EN_SS
- EN_SX
- EN_SZ
- EN_TC
- EN_TK
- EN_TO
- EN_TT
- EN_TV
- EN_TZ
- EN_UG
- EN_UM
- EN_US
- EN_US_POSIX
- EN_VC
- EN_VG
- EN_VI
- EN_VU
- EN_WS
- EN_ZA
- EN_ZM
- EN_ZW
- EO
- EO_001
- ES
- ES_419
- ES_AR
- ES_BO
- ES_BR
- ES_BZ
- ES_CL
- ES_CO
- ES_CR
- ES_CU
- ES_DO
- ES_EC
- ES_ES
- ES_GQ
- ES_GT
- ES_HN
- ES_MX
- ES_NI
- ES_PA
- ES_PE
- ES_PH
- ES_PR
- ES_PY
- ES_SV
- ES_US
- ES_UY
- ES_VE
- ET
- ET_EE
- EU
- EU_ES
- EWO
- EWO_CM
- FA
- FA_AF
- FA_IR
- FF
- FF_ADLM
- FF_ADLM_BF
- FF_ADLM_CM
- FF_ADLM_GH
- FF_ADLM_GM
- FF_ADLM_GN
- FF_ADLM_GW
- FF_ADLM_LR
- FF_ADLM_MR
- FF_ADLM_NE
- FF_ADLM_NG
- FF_ADLM_SL
- FF_ADLM_SN
- FF_LATN
- FF_LATN_BF
- FF_LATN_CM
- FF_LATN_GH
- FF_LATN_GM
- FF_LATN_GN
- FF_LATN_GW
- FF_LATN_LR
- FF_LATN_MR
- FF_LATN_NE
- FF_LATN_NG
- FF_LATN_SL
- FF_LATN_SN
- FI
- FIL
- FIL_PH
- FI_FI
- FO
- FO_DK
- FO_FO
- FR
- FR_029
- FR_BE
- FR_BF
- FR_BI
- FR_BJ
- FR_BL
- FR_CA
- FR_CD
- FR_CF
- FR_CG
- FR_CH
- FR_CI
- FR_CM
- FR_DJ
- FR_DZ
- FR_FR
- FR_GA
- FR_GF
- FR_GN
- FR_GP
- FR_GQ
- FR_HT
- FR_KM
- FR_LU
- FR_MA
- FR_MC
- FR_MF
- FR_MG
- FR_ML
- FR_MQ
- FR_MR
- FR_MU
- FR_NC
- FR_NE
- FR_PF
- FR_PM
- FR_RE
- FR_RW
- FR_SC
- FR_SN
- FR_SY
- FR_TD
- FR_TG
- FR_TN
- FR_VU
- FR_WF
- FR_YT
- FUR
- FUR_IT
- FY
- FY_NL
- GA
- GA_GB
- GA_IE
- GD
- GD_GB
- GL
- GL_ES
- GN
- GN_PY
- GSW
- GSW_CH
- GSW_FR
- GSW_LI
- GU
- GUZ
- GUZ_KE
- GU_IN
- GV
- GV_IM
- HA
- HAW
- HAW_US
- HA_GH
- HA_LATN
- HA_LATN_GH
- HA_LATN_NE
- HA_LATN_NG
- HA_NE
- HA_NG
- HE
- HE_IL
- HI
- HI_IN
- HI_LATN
- HI_LATN_IN
- HR
- HR_BA
- HR_HR
- HSB
- HSB_DE
- HU
- HU_HU
- HY
- HY_AM
- IA
- IA_001
- IBB
- IBB_NG
- ID
- ID_ID
- IG
- IG_NG
- II
- II_CN
- IS
- IS_IS
- IT
- IT_CH
- IT_IT
- IT_SM
- IT_VA
- IU
- IU_CA
- IU_CANS
- IU_CANS_CA
- IU_LATN
- IU_LATN_CA
- JA
- JA_JP
- JGO
- JGO_CM
- JMC
- JMC_TZ
- JV
- JV_ID
- JV_JAVA
- JV_JAVA_ID
- JV_LATN
- JV_LATN_ID
- KA
- KAB
- KAB_DZ
- KAM
- KAM_KE
- KA_GE
- KDE
- KDE_TZ
- KEA
- KEA_CV
- KGP
- KGP_LATN
- KGP_LATN_BR
- KHQ
- KHQ_ML
- KI
- KI_KE
- KK
- KKJ
- KKJ_CM
- KK_KZ
- KL
- KLN
- KLN_KE
- KL_GL
- KM
- KM_KH
- KN
- KN_IN
- KO
- KOK
- KOK_IN
- KO_KP
- KO_KR
- KR
- KR_LATN
- KR_LATN_NG
- KS
- KSB
- KSB_TZ
- KSF
- KSF_CM
- KSH
- KSH_DE
- KS_ARAB
- KS_ARAB_IN
- KS_ARAN
- KS_DEVA
- KS_DEVA_IN
- KS_IN
- KU
- KU_ARAB
- KU_ARAB_IQ
- KU_ARAB_IR
- KW
- KW_GB
- KY
- KY_KG
- LA
- LAG
- LAG_TZ
- LA_VA
- LB
- LB_LU
- LG
- LG_UG
- LKT
- LKT_US
- LN
- LN_AO
- LN_CD
- LN_CF
- LN_CG
- LO
- LO_LA
- LRC
- LRC_IQ
- LRC_IR
- LT
- LT_LT
- LU
- LUO
- LUO_KE
- LUY
- LUY_KE
- LU_CD
- LV
- LV_LV
- MAI
- MAI_IN
- MAS
- MAS_KE
- MAS_TZ
- MER
- MER_KE
- MFE
- MFE_MU
- MG
- MGH
- MGH_MZ
- MGO
- MGO_CM
- MG_MG
- MI
- MI_NZ
- MK
- MK_MK
- ML
- ML_IN
- MN
- MNI
- MNI_BENG
- MNI_IN
- MN_CYRL
- MN_MN
- MN_MONG
- MN_MONG_CN
- MN_MONG_MN
- MOH
- MOH_CA
- MR
- MR_IN
- MS
- MS_BN
- MS_ID
- MS_MY
- MS_SG
- MT
- MT_MT
- MUA
- MUA_CM
- MY
- MY_MM
- MZN
- MZN_IR
- NAQ
- NAQ_NA
- NB
- NB_NO
- NB_SJ
- ND
- NDS
- NDS_DE
- NDS_NL
- ND_ZW
- NE
- NE_IN
- NE_NP
- NL
- NL_AW
- NL_BE
- NL_BQ
- NL_CW
- NL_NL
- NL_SR
- NL_SX
- NMG
- NMG_CM
- NN
- NNH
- NNH_CM
- NN_NO
- NO
- NQO
- NQO_GN
- NR
- NR_ZA
- NSO
- NSO_ZA
- NUS
- NUS_SS
- NYN
- NYN_UG
- OC
- OC_ES
- OC_FR
- OM
- OM_ET
- OM_KE
- OR
- OR_IN
- OS
- OS_GE
- OS_RU
- PA
- PAP
- PAP_029
- PA_ARAB
- PA_ARAB_PK
- PA_ARAN
- PA_GURU
- PA_GURU_IN
- PA_IN
- PCM
- PCM_LATN
- PCM_LATN_NG
- PL
- PL_PL
- PRG
- PRG_001
- PS
- PS_AF
- PS_PK
- PT
- PT_AO
- PT_BR
- PT_CH
- PT_CV
- PT_GQ
- PT_GW
- PT_LU
- PT_MO
- PT_MZ
- PT_PT
- PT_ST
- PT_TL
- QU
- QUC
- QUC_GT
- QUC_LATN
- QUC_LATN_GT
- QUZ
- QUZ_BO
- QUZ_EC
- QUZ_PE
- QU_BO
- QU_EC
- QU_PE
- RAJ
- RAJ_DEVA
- RAJ_DEVA_IN
- RM
- RM_CH
- RN
- RN_BI
- RO
- ROF
- ROF_TZ
- RO_MD
- RO_RO
- RU
- RU_BY
- RU_KG
- RU_KZ
- RU_MD
- RU_RU
- RU_UA
- RW
- RWK
- RWK_TZ
- RW_RW
- SA
- SAH
- SAH_RU
- SAQ
- SAQ_KE
- SAT
- SAT_OLCK
- SAT_OLCK_IN
- SA_IN
- SBP
- SBP_TZ
- SC
- SC_LATN
- SC_LATN_IT
- SD
- SD_ARAB
- SD_ARAB_PK
- SD_DEVA
- SD_DEVA_IN
- SD_PK
- SE
- SEH
- SEH_MZ
- SES
- SES_ML
- SE_FI
- SE_NO
- SE_SE
- SG
- SG_CF
- SHI
- SHI_LATN
- SHI_LATN_MA
- SHI_TFNG
- SHI_TFNG_MA
- SI
- SI_LK
- SK
- SK_SK
- SL
- SL_SI
- SMA
- SMA_NO
- SMA_SE
- SMJ
- SMJ_NO
- SMJ_SE
- SMN
- SMN_FI
- SMS
- SMS_FI
- SN
- SN_LATN
- SN_LATN_ZW
- SN_ZW
- SO
- SO_DJ
- SO_ET
- SO_KE
- SO_SO
- SQ
- SQ_AL
- SQ_MK
- SQ_XK
- SR
- SR_CYRL
- SR_CYRL_BA
- SR_CYRL_ME
- SR_CYRL_RS
- SR_CYRL_XK
- SR_LATN
- SR_LATN_BA
- SR_LATN_ME
- SR_LATN_RS
- SR_LATN_XK
- SS
- SSY
- SSY_ER
- SS_SZ
- SS_ZA
- ST
- ST_LS
- ST_ZA
- SU
- SU_LATN
- SU_LATN_ID
- SV
- SV_AX
- SV_FI
- SV_SE
- SW
- SW_CD
- SW_KE
- SW_TZ
- SW_UG
- SYR
- SYR_SY
- TA
- TA_IN
- TA_LK
- TA_MY
- TA_SG
- TE
- TEO
- TEO_KE
- TEO_UG
- TE_IN
- TG
- TG_CYRL
- TG_CYRL_TJ
- TG_TJ
- TH
- TH_TH
- TI
- TIG
- TIG_ER
- TI_ER
- TI_ET
- TK
- TK_TM
- TN
- TN_BW
- TN_ZA
- TO
- TO_TO
- TR
- TR_CY
- TR_TR
- TS
- TS_ZA
- TT
- TT_RU
- TWQ
- TWQ_NE
- TZM
- TZM_ARAB
- TZM_ARAB_MA
- TZM_LATN
- TZM_LATN_DZ
- TZM_LATN_MA
- TZM_MA
- TZM_TFNG
- TZM_TFNG_MA
- UG
- UG_CN
- UK
- UK_UA
- UR
- UR_ARAN
- UR_IN
- UR_PK
- UZ
- UZ_ARAB
- UZ_ARAB_AF
- UZ_CYRL
- UZ_CYRL_UZ
- UZ_LATN
- UZ_LATN_UZ
- UZ_UZ
- VAI
- VAI_LATN
- VAI_LATN_LR
- VAI_VAII
- VAI_VAII_LR
- VE
- VE_ZA
- VI
- VI_VN
- VO
- VO_001
- VUN
- VUN_TZ
- WAE
- WAE_CH
- WAL
- WAL_ET
- WO
- WO_SN
- XH
- XH_ZA
- XOG
- XOG_UG
- YAV
- YAV_CM
- YI
- YI_001
- YO
- YO_BJ
- YO_NG
- YRL
- YRL_LATN
- YRL_LATN_BR
- YRL_LATN_CO
- YRL_LATN_VE
- ZGH
- ZGH_MA
- ZGH_TFNG
- ZGH_TFNG_MA
- ZH
- ZH_CH
- ZH_CHS
- ZH_CHT
- ZH_CN
- ZH_HANS
- ZH_HANS_CN
- ZH_HANS_HK
- ZH_HANS_MO
- ZH_HANS_SG
- ZH_HANT
- ZH_HANT_HK
- ZH_HANT_MO
- ZH_HANT_TW
- ZH_HK
- ZH_MO
- ZH_SG
- ZH_TW
- ZU
- ZU_ZA

### static class CultureExtensions
- Culture ToCulture(CultureInfo cultureInfo)
- CultureInfo ToCultureInfo(Culture culture)

### enum DataSourceFetch
- AtStart
- OnDemand

### enum DBMSType
- All
- MySQL
- Oracle
- SqlServer

### enum DeleteRule
- Protect
- Delete
- Ignore

### enum DeployAction
- Ignore
- CopyToApplicationDir

### enum DesignMode
- ShowAll
- ShowTrueOrPreview
- ShowFalse

### enum DisplayColumns
- One
- Two

### enum EffectiveMarginLeftType
- UserDefined
- Auto_0
- Auto_Gutter
- UserDefinedCols
- UserDefinedColsWithGutter

### enum EffectiveWidthType
- UserDefined
- FillParent
- InlineBlock
- UserDefinedCols

### enum ESpaceTreeFolder
- ServerActions
- ClientActions
- SiteProperties
- SessionVariables
- ClientVariables
- Structures
- Timers
- Roles
- Images
- Resources
- Scripts
- ServiceActions
- Processes
- EntityDiagrams
- Themes
- ServerEntities
- ClientEntities
- Entities
- Aggregates
- Views
- Events
- Agents

### enum ExecuteActionAnimationEffectType
- None
- Highlight
- Fade

### enum FileType
- Unknown
- Solution
- Application
- eSpace
- Extension

### enum FlexDirection
- Row
- Column
- RowReverse
- ColumnReverse

### enum Flexible
- Shrink
- Fixed
- Grow
- Both

### enum FlexWrap
- NoWrap
- Wrap
- WrapReverse

### enum Frequency
- None
- Daily
- Weekly
- Monthly

### enum GridType
- Inherited
- Fixed
- Fluid
- No

### enum HTTPSecurityWithCertificates
- None
- SSL
- SSLWithClientCertificates

### enum HTTPSecurityWithCertificatesAndInheritance
- Inherited
- None
- SSL
- SSLWithClientCertificates

### enum ImageCache
- None
- Hour
- Day
- Week

### enum ImageType
- Static
- External
- Database

### enum InputType
- Text
- Number
- Email
- Search

### enum JoinType
- None
- Inner
- Right
- Left
- Full

### enum JQueryVersion
- JQuery183
- JQuery142
- NotApplicable

### enum JSONDateFormat
- ISO
- UNIX

### enum JustifyContent
- Start
- Center
- End
- SpaceBetween
- SpaceAround

### enum ListBoxSelectionMode
- Single
- Multiple

### enum ListRecordsLineSeparator
- NewLine
- None
- Bullets

### enum LoadFlags
- None
- ReadOnly
- SkipUpgrades
- Recovery
- SkipMissingModelPlugins

### enum LoadingMessagePosition
- Top
- Bottom

### enum LoadingPatternType
- System
- None

### enum LoadingScreenType
- Native
- Custom

### enum MCPToolReferenceKind
- Local
- Remote

### enum MessageType
- Info
- Success
- Warning
- Error

### enum Method
- Submit
- Ajax
- Navigate

### enum MobileFramework
- Cordova
- Capacitor

### enum PasswordType
- Text
- Numeric

### enum PlatformServerVersion
- O11
- Neo

### enum Priority
- Top
- High
- Normal
- Low

### enum PropertyKind
- Value
- Expression
- Variable

### enum ReferenceKind
- eSpace
- Extension
- Unknown
- ExternalConnection
- ExternalLibrary
- ModelPlugin
- AIModelConnection
- SearchServiceConnection
- MCPConnection
- A2AConnection
- KnowledgeBase
- AINativeConnection

### enum ScheduleInterval
- Any
- AtOrOn
- Every
- Between

### enum ScreenTransition
- Fade
- SlideFromLeft
- SlideFromRight
- SlideFromBottom
- SlideFromTop

### enum SegmentationKind
- WebResponsive
- Mobile
- Service
- Unknown
- CrossDevice
- Extension
- MobileLibrary
- ReactiveLibrary
- WebResponsiveLibrary
- ExternalConnection
- ExternalLibrary
- ModelPlugin
- BusinessProcess
- AIModelConnection
- SearchServiceConnection
- AIAgent
- MCPConnection
- A2AConnection
- AgentDefinition
- KnowledgeBase
- AINativeConnection

### enum Sort
- Ascending
- Descending

### enum TextResourcesFileFormat
- Excel
- ResX

### enum TextResourceType
- Property
- ExpressionTextLiteral
- JavaScriptTextLiteral

### enum ThemeProperty
- AppPrimaryColor
- PrimaryColor
- SecondaryColor
- BackgroundColor
- HeaderColor
- Palette
- CustomPaletteColors
- Font
- FontSize
- FontBoldResource
- FontRegularResource
- Spacing
- HeaderSize
- Border
- ShadowEffectEnabled
- LoginBackgroundColor
- LoginBackgroundGradient
- LoginBackgroundImageRuntimePath
- LoginBackgroundSelectedSamplePath
- NativeLookAndFeelSelected
- CreatedWithoutCustomCSS

### enum TimeoutMode
- Basic
- Custom

### enum TimeUnit
- None
- Days
- Hours
- Minutes
- Seconds

### enum TransitionType
- None
- Fade
- SlideFromLeft
- SlideFromRight
- SlideFromBottom
- SlideFromTop

### enum TransitionTypeWithInheritance
- Inherited
- UseHistory
- None
- Fade
- SlideFromLeft
- SlideFromRight
- SlideFromBottom
- SlideFromTop

### enum TranslationBehavior
- Undefined
- Translate
- DontTranslate

### enum TriggerMode
- Event
- Schedule

### enum UpdateEntityBehaviorType
- Full
- Optimized

### enum URLStructure
- QueryString
- Path

### enum Validation
- ClientAndServer
- Server
- None

### enum ValidationBehavior
- None
- ValidateAndContinue

### enum VerticalAlignment
- Null
- Top
- Middle
- Bottom

### enum WebScreenRenderingMode
- Standards
- HTML5
- Quirks

### enum WidgetGridType
- None
- Flexbox
- Grid

## OutSystems.Model.Enumerations.ModelPlugins

### enum LambdaExpressionTarget
- NotApplicable
- AttributeValue
- AttributeName

### enum ModelPropertyKind
- StringProperty
- BooleanProperty
- IntegerProperty
- EnumProperty
- StyleProperty
- VariableProperty
- RecordProperty
- RecordListProperty
- WidgetReferenceProperty
- ImageReferenceProperty
- ExpressionProperty
- TypeReferenceProperty
- BuiltInProperty
- LambdaExpressionProperty
- BuiltInExpressionProperty

### enum PropertyRuntimeType
- NotApplicable
- Boolean
- Integer
- LongInteger
- String
- Time
- Date
- DateTime
- Decimal
- Currency
- Email
- PhoneNumber
- LegacyStyle
- Style
- Enum
- Variable
- Record
- List
- ObjectReference
- Expression
- WidgetReference
- TypeReference
- BuiltInProperty
- ImageReference
- BinaryData
- File
- LambdaExpression
- EntityIdentifier
- EntityTextIdentifier
- EntityLongIdentifier
- Any

## OutSystems.Model.Events

### interface IModelEventsHandler
- void ChangingName(IObjectSignature obj)
- void CreatedObject(IObjectSignature obj)
- void DeletedObject(IObjectSignature obj)
- void DeletingObject(IObjectSignature obj)
- void FixOnImport(IObjectSignature obj)
- void MergedObject(IObjectSignature obj)

### class ModelEventsHandler<ObjectType> : IModelEventsHandler
- void ChangingName(IObjectSignature obj)
- void CreatedObject(IObjectSignature obj)
- void DeletedObject(IObjectSignature obj)
- void DeletingObject(IObjectSignature obj)
- void FixOnImport(IObjectSignature obj)
- void MergedObject(IObjectSignature obj)

## OutSystems.Model.Expressions

### static class BuiltinFunctionsInfo
- IBuiltinFunctionInfo Abs { get; }
- IBuiltinFunctionInfo AddDays { get; }
- IBuiltinFunctionInfo AddHours { get; }
- IBuiltinFunctionInfo AddMinutes { get; }
- IBuiltinFunctionInfo AddMonths { get; }
- IBuiltinFunctionInfo AddPersonalAreaToURLPath { get; }
- IBuiltinFunctionInfo AddSeconds { get; }
- IBuiltinFunctionInfo AddYears { get; }
- IEnumerable<IBuiltinFunctionInfo> All { get; }
- IBuiltinFunctionInfo BooleanToInteger { get; }
- IBuiltinFunctionInfo BooleanToText { get; }
- IBuiltinFunctionInfo BuildDateTime { get; }
- IBuiltinFunctionInfo CheckEndUserRole { get; }
- IBuiltinFunctionInfo CheckRole { get; }
- IBuiltinFunctionInfo Chr { get; }
- IBuiltinFunctionInfo Concat { get; }
- IBuiltinFunctionInfo CurrDate { get; }
- IBuiltinFunctionInfo CurrDateTime { get; }
- IBuiltinFunctionInfo CurrentThemeIsMobile { get; }
- IBuiltinFunctionInfo CurrTime { get; }
- IBuiltinFunctionInfo DateTimeToDate { get; }
- IBuiltinFunctionInfo DateTimeToText { get; }
- IBuiltinFunctionInfo DateTimeToTime { get; }
- IBuiltinFunctionInfo DateToDateTime { get; }
- IBuiltinFunctionInfo DateToText { get; }
- IBuiltinFunctionInfo Day { get; }
- IBuiltinFunctionInfo DayOfWeek { get; }
- IBuiltinFunctionInfo DecimalToBoolean { get; }
- IBuiltinFunctionInfo DecimalToInteger { get; }
- IBuiltinFunctionInfo DecimalToIntegerValidate { get; }
- IBuiltinFunctionInfo DecimalToLongInteger { get; }
- IBuiltinFunctionInfo DecimalToLongIntegerValidate { get; }
- IBuiltinFunctionInfo DecimalToText { get; }
- IBuiltinFunctionInfo DiffDays { get; }
- IBuiltinFunctionInfo DiffHours { get; }
- IBuiltinFunctionInfo DiffMinutes { get; }
- IBuiltinFunctionInfo DiffSeconds { get; }
- IBuiltinFunctionInfo EmailAddressCreate { get; }
- IBuiltinFunctionInfo EmailAddressesConcatenate { get; }
- IBuiltinFunctionInfo EmailAddressValidate { get; }
- IBuiltinFunctionInfo EncodeHtml { get; }
- IBuiltinFunctionInfo EncodeJavaScript { get; }
- IBuiltinFunctionInfo EncodeSql { get; }
- IBuiltinFunctionInfo EncodeUrl { get; }
- IBuiltinFunctionInfo FormatCurrency { get; }
- IBuiltinFunctionInfo FormatDateTime { get; }
- IBuiltinFunctionInfo FormatDecimal { get; }
- IBuiltinFunctionInfo FormatPercent { get; }
- IBuiltinFunctionInfo FormatPhoneNumber { get; }
- IBuiltinFunctionInfo FormatText { get; }
- IBuiltinFunctionInfo GeneratePassword { get; }
- IBuiltinFunctionInfo GetApplicationServerType { get; }
- IBuiltinFunctionInfo GetAppName { get; }
- IBuiltinFunctionInfo GetBookmarkableURL { get; }
- IBuiltinFunctionInfo GetCurrentLocale { get; }
- IBuiltinFunctionInfo GetDatabaseProvider { get; }
- IBuiltinFunctionInfo GetEntryEspaceId { get; }
- IBuiltinFunctionInfo GetEntryEspaceName { get; }
- IBuiltinFunctionInfo GetExceptionURL { get; }
- IBuiltinFunctionInfo GetObsoleteTenantId { get; }
- IBuiltinFunctionInfo GetOwnerEspaceIdentifier { get; }
- IBuiltinFunctionInfo GetOwnerURLPath { get; }
- IBuiltinFunctionInfo GetPersonalAreaName { get; }
- IBuiltinFunctionInfo GetUserAgent { get; }
- IBuiltinFunctionInfo GetUserId { get; }
- IBuiltinFunctionInfo Hour { get; }
- IBuiltinFunctionInfo IdentifierToInteger { get; }
- IBuiltinFunctionInfo IdentifierToLongInteger { get; }
- IBuiltinFunctionInfo IdentifierToText { get; }
- IBuiltinFunctionInfo If { get; }
- IBuiltinFunctionInfo Index { get; }
- IBuiltinFunctionInfo IntegerToBoolean { get; }
- IBuiltinFunctionInfo IntegerToDecimal { get; }
- IBuiltinFunctionInfo IntegerToIdentifier { get; }
- IBuiltinFunctionInfo IntegerToText { get; }
- IBuiltinFunctionInfo IsLoadingScreen { get; }
- IBuiltinFunctionInfo IsOwnedByCurrentApp { get; }
- IBuiltinFunctionInfo IsTemp { get; }
- IBuiltinFunctionInfo Length { get; }
- IBuiltinFunctionInfo LongIntegerToIdentifier { get; }
- IBuiltinFunctionInfo LongIntegerToInteger { get; }
- IBuiltinFunctionInfo LongIntegerToIntegerValidate { get; }
- IBuiltinFunctionInfo LongIntegerToText { get; }
- IBuiltinFunctionInfo Max { get; }
- IBuiltinFunctionInfo MIMEType { get; }
- IBuiltinFunctionInfo Min { get; }
- IBuiltinFunctionInfo Minute { get; }
- IBuiltinFunctionInfo Mod { get; }
- IBuiltinFunctionInfo Month { get; }
- IBuiltinFunctionInfo NewDate { get; }
- IBuiltinFunctionInfo NewDateTime { get; }
- IBuiltinFunctionInfo NewLine { get; }
- IBuiltinFunctionInfo NewTime { get; }
- IBuiltinFunctionInfo NullBinary { get; }
- IBuiltinFunctionInfo NullDate { get; }
- IBuiltinFunctionInfo NullFile { get; }
- IBuiltinFunctionInfo NullIdentifier { get; }
- IBuiltinFunctionInfo NullObject { get; }
- IBuiltinFunctionInfo NullTextIdentifier { get; }
- IBuiltinFunctionInfo Power { get; }
- IBuiltinFunctionInfo Replace { get; }
- IBuiltinFunctionInfo Round { get; }
- IBuiltinFunctionInfo Second { get; }
- IBuiltinFunctionInfo Sign { get; }
- IBuiltinFunctionInfo Size { get; }
- IBuiltinFunctionInfo Sqrt { get; }
- IBuiltinFunctionInfo Substr { get; }
- IBuiltinFunctionInfo TextToDate { get; }
- IBuiltinFunctionInfo TextToDateTime { get; }
- IBuiltinFunctionInfo TextToDateTimeValidate { get; }
- IBuiltinFunctionInfo TextToDateValidate { get; }
- IBuiltinFunctionInfo TextToDecimal { get; }
- IBuiltinFunctionInfo TextToDecimalValidate { get; }
- IBuiltinFunctionInfo TextToIdentifier { get; }
- IBuiltinFunctionInfo TextToInteger { get; }
- IBuiltinFunctionInfo TextToIntegerValidate { get; }
- IBuiltinFunctionInfo TextToLongInteger { get; }
- IBuiltinFunctionInfo TextToLongIntegerValidate { get; }
- IBuiltinFunctionInfo TextToTime { get; }
- IBuiltinFunctionInfo TextToTimeValidate { get; }
- IBuiltinFunctionInfo TimeToText { get; }
- IBuiltinFunctionInfo ToLower { get; }
- IBuiltinFunctionInfo ToObject { get; }
- IBuiltinFunctionInfo ToUpper { get; }
- IBuiltinFunctionInfo Trim { get; }
- IBuiltinFunctionInfo TrimEnd { get; }
- IBuiltinFunctionInfo TrimStart { get; }
- IBuiltinFunctionInfo Trunc { get; }
- IBuiltinFunctionInfo Year { get; }
- IBuiltinFunctionInfo Get(string name)

### enum EnvironmentEntryKind
- ClientFunction
- ServerFunction
- Other

### class ExpressionDefinition : IEquatable<ExpressionDefinition>
- ITypeSignature Type { get; }
- ExpressionDefinition Convert(object value)
- bool Equals(ExpressionDefinition other)
- ExpressionDefinition Parse(string text)

### static class ExpressionExtensions
- IModelObject GetAssociatedObject(IExpression expression)
- IModelObject GetAssociatedObject(IExpressionNode node)
- ExpressionDefinition ToExpressionDefinition(IExpression expression)
- ExpressionDefinition ToExpressionDefinition(IExpressionNode node)

### interface IAIRecordLiteralField : IRecordLiteralField
- string Description { get; set; }
- IAIRecordLiteralFieldDescriptor Descriptor { get; }
- bool IsFilledByAI { get; set; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IAIRecordLiteralFieldDescriptor : IRecordLiteralFieldDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IsFilledByAIProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface IAttributeMapping
- string Description { get; set; }
- bool IsFilledByAI { get; }
- IExpression SourceValue { get; }
- IExpression TargetValue { get; }
- void SetSourceValue(ExpressionDefinition value)

### interface IBinding : IEquatable<IBinding>

### interface IBuiltinFunction : IBuiltinFunctionInfo
- IEnumerable<IBuiltinFunction.IInputParameter> InputParameters { get; }
- bool IsVisibleInBusinessProcesses { get; }
- bool IsVisibleInClientAggregates { get; }
- bool IsVisibleInClientSide { get; }
- bool IsVisibleInMobileEmails { get; }
- bool IsVisibleInScripts { get; }
- bool IsVisibleInServerAggregates { get; }
- ITypeSignature Type { get; }

### interface IBuiltinFunctionBinding : IByNameBinding
- IBuiltinFunction Function { get; set; }

### interface IBuiltinFunctionInfo
- string Description { get; }
- IEnumerable<IBuiltinFunctionInfo.IInputParameterInfo> InputParameters { get; }
- string Name { get; }
- TypeKind TypeKind { get; }

### interface IBuiltinFunctions
- IBuiltinFunction Abs { get; }
- IBuiltinFunction AddDays { get; }
- IBuiltinFunction AddHours { get; }
- IBuiltinFunction AddMinutes { get; }
- IBuiltinFunction AddMonths { get; }
- IBuiltinFunction AddPersonalAreaToURLPath { get; }
- IBuiltinFunction AddSeconds { get; }
- IBuiltinFunction AddYears { get; }
- IEnumerable<IBuiltinFunction> All { get; }
- IBuiltinFunction BooleanToInteger { get; }
- IBuiltinFunction BooleanToText { get; }
- IBuiltinFunction BuildDateTime { get; }
- IBuiltinFunction CheckEndUserRole { get; }
- IBuiltinFunction CheckRole { get; }
- IBuiltinFunction Chr { get; }
- IBuiltinFunction Concat { get; }
- IBuiltinFunction CurrDate { get; }
- IBuiltinFunction CurrDateTime { get; }
- IBuiltinFunction CurrentThemeIsMobile { get; }
- IBuiltinFunction CurrTime { get; }
- IBuiltinFunction DateTimeToDate { get; }
- IBuiltinFunction DateTimeToText { get; }
- IBuiltinFunction DateTimeToTime { get; }
- IBuiltinFunction DateToDateTime { get; }
- IBuiltinFunction DateToText { get; }
- IBuiltinFunction Day { get; }
- IBuiltinFunction DayOfWeek { get; }
- IBuiltinFunction DecimalToBoolean { get; }
- IBuiltinFunction DecimalToInteger { get; }
- IBuiltinFunction DecimalToIntegerValidate { get; }
- IBuiltinFunction DecimalToLongInteger { get; }
- IBuiltinFunction DecimalToLongIntegerValidate { get; }
- IBuiltinFunction DecimalToText { get; }
- IBuiltinFunction DiffDays { get; }
- IBuiltinFunction DiffHours { get; }
- IBuiltinFunction DiffMinutes { get; }
- IBuiltinFunction DiffSeconds { get; }
- IBuiltinFunction EmailAddressCreate { get; }
- IBuiltinFunction EmailAddressesConcatenate { get; }
- IBuiltinFunction EmailAddressValidate { get; }
- IBuiltinFunction EncodeHtml { get; }
- IBuiltinFunction EncodeJavaScript { get; }
- IBuiltinFunction EncodeSql { get; }
- IBuiltinFunction EncodeUrl { get; }
- IBuiltinFunction FormatCurrency { get; }
- IBuiltinFunction FormatDateTime { get; }
- IBuiltinFunction FormatDecimal { get; }
- IBuiltinFunction FormatPercent { get; }
- IBuiltinFunction FormatPhoneNumber { get; }
- IBuiltinFunction FormatText { get; }
- IBuiltinFunction GeneratePassword { get; }
- IBuiltinFunction GetApplicationServerType { get; }
- IBuiltinFunction GetAppName { get; }
- IBuiltinFunction GetBookmarkableURL { get; }
- IBuiltinFunction GetCurrentLocale { get; }
- IBuiltinFunction GetDatabaseProvider { get; }
- IBuiltinFunction GetEntryEspaceId { get; }
- IBuiltinFunction GetEntryEspaceName { get; }
- IBuiltinFunction GetExceptionURL { get; }
- IBuiltinFunction GetObsoleteTenantId { get; }
- IBuiltinFunction GetOwnerEspaceIdentifier { get; }
- IBuiltinFunction GetOwnerURLPath { get; }
- IBuiltinFunction GetPersonalAreaName { get; }
- IBuiltinFunction GetUserAgent { get; }
- IBuiltinFunction GetUserId { get; }
- IBuiltinFunction Hour { get; }
- IBuiltinFunction IdentifierToInteger { get; }
- IBuiltinFunction IdentifierToLongInteger { get; }
- IBuiltinFunction IdentifierToText { get; }
- IBuiltinFunction If { get; }
- IBuiltinFunction Index { get; }
- IBuiltinFunction IntegerToBoolean { get; }
- IBuiltinFunction IntegerToDecimal { get; }
- IBuiltinFunction IntegerToIdentifier { get; }
- IBuiltinFunction IntegerToText { get; }
- IBuiltinFunction IsLoadingScreen { get; }
- IBuiltinFunction IsOwnedByCurrentApp { get; }
- IBuiltinFunction IsTemp { get; }
- IBuiltinFunction Length { get; }
- IBuiltinFunction LongIntegerToIdentifier { get; }
- IBuiltinFunction LongIntegerToInteger { get; }
- IBuiltinFunction LongIntegerToIntegerValidate { get; }
- IBuiltinFunction LongIntegerToText { get; }
- IBuiltinFunction Max { get; }
- IBuiltinFunction MIMEType { get; }
- IBuiltinFunction Min { get; }
- IBuiltinFunction Minute { get; }
- IBuiltinFunction Mod { get; }
- IBuiltinFunction Month { get; }
- IBuiltinFunction NewDate { get; }
- IBuiltinFunction NewDateTime { get; }
- IBuiltinFunction NewLine { get; }
- IBuiltinFunction NewTime { get; }
- IBuiltinFunction NullBinary { get; }
- IBuiltinFunction NullDate { get; }
- IBuiltinFunction NullFile { get; }
- IBuiltinFunction NullIdentifier { get; }
- IBuiltinFunction NullObject { get; }
- IBuiltinFunction NullTextIdentifier { get; }
- IBuiltinFunction Power { get; }
- IBuiltinFunction Replace { get; }
- IBuiltinFunction Round { get; }
- IBuiltinFunction Second { get; }
- IBuiltinFunction Sign { get; }
- IBuiltinFunction Size { get; }
- IBuiltinFunction Sqrt { get; }
- IBuiltinFunction Substr { get; }
- IBuiltinFunction TextToDate { get; }
- IBuiltinFunction TextToDateTime { get; }
- IBuiltinFunction TextToDateTimeValidate { get; }
- IBuiltinFunction TextToDateValidate { get; }
- IBuiltinFunction TextToDecimal { get; }
- IBuiltinFunction TextToDecimalValidate { get; }
- IBuiltinFunction TextToIdentifier { get; }
- IBuiltinFunction TextToInteger { get; }
- IBuiltinFunction TextToIntegerValidate { get; }
- IBuiltinFunction TextToLongInteger { get; }
- IBuiltinFunction TextToLongIntegerValidate { get; }
- IBuiltinFunction TextToTime { get; }
- IBuiltinFunction TextToTimeValidate { get; }
- IBuiltinFunction TimeToText { get; }
- IBuiltinFunction ToLower { get; }
- IBuiltinFunction ToObject { get; }
- IBuiltinFunction ToUpper { get; }
- IBuiltinFunction Trim { get; }
- IBuiltinFunction TrimEnd { get; }
- IBuiltinFunction TrimStart { get; }
- IBuiltinFunction Trunc { get; }
- IBuiltinFunction Year { get; }
- IBuiltinFunction Get(string name)

### interface IByNameBinding : IBinding
- string Name { get; set; }

### interface IElementOfTextWithReferenceElements

### interface IEnvironment
- IEnumerable<IEnvironmentEntry> Entries { get; }
- IEnvironmentEntry Lookup(string name, EnvironmentEntryKind kind = Other)

### interface IEnvironmentEntry
- IEnumerable<IEnvironmentEntry> Children { get; }
- string Description { get; }
- string FullName { get; }
- bool IsFunction { get; }
- bool IsReadOnly { get; }
- string Name { get; }
- IObjectSignature Object { get; }
- IEnvironmentEntry Parent { get; }
- ITypeSignature Type { get; }
- IEnvironmentEntry Lookup(string name, EnvironmentEntryKind kind)

### interface IExpression : IObject
- IExpressionDescriptor Descriptor { get; }
- IEnvironment Environment { get; }
- IExpressionNode ExpandedRoot { get; }
- string ExpandedText { get; }
- IExpressionNode Root { get; }
- string Text { get; set; }
- ITypeSignature Type { get; }
- IMutableExpression AsMutableExpression()
- void SubstituteAndSimplify(Dictionary<IObjectSignature, object> substitutions)

### interface IExpressionDescriptor : IObjectDescriptor
- IProperty TypeProperty { get; }

### interface IListLiteralExpression : IExpression
- IListLiteralExpressionDescriptor Descriptor { get; }
- ISequence<IListLiteralItem> Items { get; }
- IListLiteralItem CreateItem()

### interface IListLiteralExpressionDescriptor : IExpressionDescriptor
- IChildCollection ItemsChildCollection { get; }

### interface IListLiteralItem : IObject
- IListLiteralItemDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IListLiteralItemDescriptor : IObjectDescriptor
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IMutableExpression : IExpression
- T CloneNode<T>(T node)
- void Commit()
- IArgument CreateArgument(IExpressionNode value, IBinding parameter = null, bool hasName = False, string whitespaceBefore = null, string whitespaceBeforeColon = null, string whitespaceAfter = null)
- IBinaryOperation CreateBinaryOperation(BinaryOperator operator, IExpressionNode leftOperand, IExpressionNode rightOperand, string whitespaceBefore = null, string whitespaceAfter = null)
- IBinaryOperation CreateBinaryOperation(BinaryOperator operator, Quantifier quantifier, IExpressionNode leftOperand, IExpressionNode rightOperand, string whitespaceBefore = null, string whitespaceAfter = null)
- IBooleanLiteral CreateBooleanLiteral(bool value, string whitespaceBefore = null, string whitespaceAfter = null)
- IBuiltinFunctionBinding CreateBuiltinFunctionBinding(IBuiltinFunction function)
- IByNameBinding CreateByNameBinding(string name)
- IDateLiteral CreateDateLiteral(DateTime value, string whitespaceBefore = null, string whitespaceAfter = null)
- IDateTimeLiteral CreateDateTimeLiteral(DateTime value, string whitespaceBefore = null, string whitespaceAfter = null)
- IDecimalLiteral CreateDecimalLiteral(decimal value, string whitespaceBefore = null, string whitespaceAfter = null)
- IExpressionSnippet CreateExpressionSnippet(string value, string whitespaceBefore = null, string whitespaceAfter = null)
- IFieldAccess CreateFieldAccess(IExpressionNode record, IIdentifier field, string whitespaceBefore = null, string whitespaceAfter = null)
- IFunctionCall CreateFunctionCall(IBinding function, IEnumerable<IArgument> arguments, string whitespaceBefore = null, string whitespaceAfter = null, string whitespaceAfterFunctionName = null, string whitespaceBetweenParenthesis = null)
- IIdentifier CreateIdentifier(IBinding binding, string whitespaceBefore = null, string whitespaceAfter = null)
- IIndexer CreateIndexer(IExpressionNode list, IExpressionNode index, string whitespaceBefore = null, string whitespaceAfter = null)
- IIntegerLiteral CreateIntegerLiteral(int value, string whitespaceBefore = null, string whitespaceAfter = null)
- IListLiteral CreateListLiteral(IEnumerable<IExpressionNode> items)
- ILongLiteral CreateLongLiteral(long value, string whitespaceBefore = null, string whitespaceAfter = null)
- IObjectBinding CreateObjectBinding(IObjectSignature object)
- IRecordLiteral CreateRecordLiteral(IEnumerable<IRecordLiteralField> fields)
- IRecordLiteralField CreateRecordLiteralField(IAttributeSignature attribute, IExpressionNode value)
- ITextLiteral CreateTextLiteral(string value, string whitespaceBefore = null, string whitespaceAfter = null)
- ITimeLiteral CreateTimeLiteral(DateTime value, string whitespaceBefore = null, string whitespaceAfter = null)
- ITypeConversion CreateTypeConversion(IExpressionNode sourceValue, IEnumerable<ITypeConversionMapping> mappings)
- ITypeConversionMapping CreateTypeConversionMapping(IExpressionNode sourceValue, IExpressionNode targetValue)
- IUnaryOperation CreateUnaryOperation(UnaryOperator operator, IExpressionNode operand, string whitespaceBefore = null, string whitespaceAfter = null)
- IUnknownObjectBinding CreateUnknownObjectBinding(string name)

### interface IObjectBinding : IBinding
- IObjectSignature Object { get; set; }

### interface IRecordLiteralExpression : IExpression
- IRecordLiteralExpressionDescriptor Descriptor { get; }
- ISequence<IRecordLiteralField> Fields { get; }
- void RemoveIgnoredAttributes()

### interface IRecordLiteralExpressionDescriptor : IExpressionDescriptor
- IChildCollection FieldsChildCollection { get; }

### interface IRecordLiteralField : IObject
- IAttributeSignature Attribute { get; }
- IRecordLiteralFieldDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface IRecordLiteralFieldDescriptor : IObjectDescriptor
- IProperty AttributeProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IReferenceElement : IElementOfTextWithReferenceElements
- IObjectSignature Object { get; }

### interface ITextBasedExpression : IExpression
- ITextBasedExpressionDescriptor Descriptor { get; }
- void ReplaceBuiltinFunction(IBuiltinFunction oldFunction, IBuiltinFunction newFunction)

### interface ITextBasedExpressionDescriptor : IExpressionDescriptor

### interface ITextElement : IElementOfTextWithReferenceElements
- string Text { get; }

### interface ITextWithReferencedElements : IObject
- ITextWithReferencedElementsDescriptor Descriptor { get; }
- IEnumerable<IElementOfTextWithReferenceElements> Elements { get; }
- string Text { get; }

### interface ITextWithReferencedElementsDescriptor : IObjectDescriptor

### interface ITypeConversionExpression : IExpression
- ITypeConversionExpressionDescriptor Descriptor { get; }
- bool IsListConversion { get; }
- IEnumerable<IAttributeMapping> Mappings { get; }
- ITypeSignature SourceElementType { get; }
- IExpression SourceValue { get; }
- ITypeSignature TargetElementType { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- bool UseImplicitConversion { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetSourceValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ITypeConversionExpressionDescriptor : IExpressionDescriptor
- IProperty IsListConversionProperty { get; }
- IProperty SourceElementTypeProperty { get; }
- IProperty SourceValueProperty { get; }
- IProperty TargetElementTypeProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty UseImplicitConversionProperty { get; }

### interface IUnknownObjectBinding : IBinding
- string Name { get; set; }

## OutSystems.Model.Expressions.EnvironmentTree

### interface IEnvironmentTreeFolder : IEnvironmentTreeItem
- string Icon { get; }

### interface IEnvironmentTreeFunction : IEnvironmentTreeItem
- string Examples { get; }
- IEnumerable<IEnvironmentTreeFunction.Parameter> Parameters { get; }
- string Signature { get; }
- ITypeSignature Type { get; }

### interface IEnvironmentTreeItem
- IEnumerable<IEnvironmentTreeItem> Children { get; }
- string Description { get; }
- IEnvironmentEntry Entry { get; }
- string Name { get; }
- IObjectSignature Owner { get; }
- IEnvironmentTreeItem Parent { get; }

## OutSystems.Model.Expressions.Nodes

### enum BinaryOperator
- Plus
- Minus
- Multiply
- Divide
- Like
- Equal
- NotEqual
- Less
- LessOrEqual
- Greater
- GreaterOrEqual
- And
- Or

### interface IArgument : IExpressionNode
- bool HasName { get; set; }
- IBinding Parameter { get; set; }
- IExpressionNode Value { get; set; }
- string WhitespaceBeforeColon { get; set; }

### interface IBinaryOperation : IExpressionNode
- IExpressionNode LeftOperand { get; set; }
- BinaryOperator Operator { get; set; }
- Quantifier Quantifier { get; set; }
- IExpressionNode RightOperand { get; set; }

### interface IBooleanLiteral : IExpressionNode
- bool Value { get; set; }

### interface IDateLiteral : IExpressionNode
- DateTime Value { get; set; }

### interface IDateTimeLiteral : IExpressionNode
- DateTime Value { get; set; }

### interface IDecimalLiteral : IExpressionNode
- decimal Value { get; set; }

### interface IExpressionNode
- IEnumerable<IExpressionNode> Children { get; }
- IExpression Owner { get; }
- IExpressionNode Parent { get; }
- string Text { get; }
- ITypeSignature Type { get; }
- IEnumerable<IModelObject> UsedObjects { get; }
- string WhitespaceAfter { get; set; }
- string WhitespaceBefore { get; set; }
- void ReplaceBy(IExpressionNode newNode, bool transferWhitespace = True)

### interface IExpressionSnippet : IExpressionNode
- string Value { get; set; }

### interface IFieldAccess : IExpressionNode
- IIdentifier Field { get; set; }
- IExpressionNode Record { get; set; }

### interface IFunctionCall : IExpressionNode
- IEnumerable<IArgument> Arguments { get; set; }
- IBinding Function { get; set; }
- string WhitespaceAfterFunctionName { get; set; }
- string WhitespaceBetweenParenthesis { get; set; }

### interface IIdentifier : IExpressionNode
- IBinding Binding { get; set; }

### interface IIndexer : IExpressionNode
- IExpressionNode Index { get; set; }
- IExpressionNode List { get; set; }

### interface IIntegerLiteral : IExpressionNode
- int Value { get; set; }

### interface IListLiteral : IExpressionNode
- IEnumerable<IExpressionNode> Items { get; set; }

### interface ILongLiteral : IExpressionNode
- long Value { get; set; }

### interface IRecordLiteral : IExpressionNode
- IEnumerable<IRecordLiteralField> Fields { get; set; }

### interface IRecordLiteralField : IExpressionNode
- IAttributeSignature Attribute { get; set; }
- IExpressionNode Value { get; set; }

### interface ITextLiteral : IExpressionNode
- string Value { get; set; }

### interface ITimeLiteral : IExpressionNode
- DateTime Value { get; set; }

### interface ITypeConversion : IExpressionNode
- IEnumerable<ITypeConversionMapping> Mappings { get; set; }
- IExpressionNode SourceValue { get; set; }
- ITypeSignature TargetElementType { get; set; }

### interface ITypeConversionMapping : IExpressionNode
- IExpressionNode SourceValue { get; set; }
- IExpressionNode TargetValue { get; set; }

### interface IUnaryOperation : IExpressionNode
- IExpressionNode Operand { get; set; }
- UnaryOperator Operator { get; set; }

### enum Quantifier
- None
- Any
- All

### enum UnaryOperator
- Minus
- Not

## OutSystems.Model.Extensions

### enum DeployAction
- Ignore
- CopyToBinariesDirectory
- CopyToApplicationDirectory
- CopyToImagesDirectory

### enum ExtensionKind
- Extension
- ExternalConnection
- ExternalLibrary
- ModelPlugin
- AIModelConnection
- SearchServiceConnection
- MCPConnection
- A2AConnection
- KnowledgeBase
- AINativeConnection

### interface IAction : IShareableExtensionObject<IAction, IServerActionSignature>
- IReadOnlyList<KeyValuePair<string, string>> AdditionalInformation { get; }
- string Description { get; set; }
- IActionDescriptor Descriptor { get; }
- bool Function { get; set; }
- Byte[] Icon { get; set; }
- string IntegrationName { get; set; }
- string Name { get; set; }
- ISequence<IParameter> Parameters { get; }
- void ClearAdditionalInformation()
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- void RemoveAdditionalInformation(string key)
- void SetAdditionalInformation(string key, string value)

### interface IActionDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty FunctionProperty { get; }
- IProperty IconProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IAction, IParameter> ParametersChildCollection { get; }

### interface IAnonymousStructure : IRecordType
- IEnumerable<IAttribute> Attributes { get; }
- IAnonymousStructureDescriptor Descriptor { get; }

### interface IAnonymousStructureDescriptor : IRecordTypeDescriptor
- IChildCollection<IAnonymousStructure, IAttribute> AttributesChildCollection { get; }

### interface IAttribute : IModelObject
- IType DataType { get; }
- IAttributeDescriptor Descriptor { get; }
- string Name { get; }

### interface IAttributeDescriptor : IClassDescriptor
- IProperty DataTypeProperty { get; }
- IProperty NameProperty { get; }

### interface IBasicType : IType
- IBasicTypeDescriptor Descriptor { get; }
- TypeKind Kind { get; }
- bool IsAssignableTo(ITypeSignature other)

### interface IBasicTypeDescriptor : IClassDescriptor

### interface IEntity : IRecordType, IShareableExtensionObject<IEntity, IEntitySignature>
- ISequence<IEntityAttribute> Attributes { get; }
- bool ConvertDefaultValueToFromNullInDatabase { get; set; }
- string Description { get; set; }
- IEntityDescriptor Descriptor { get; }
- bool ExposeAsReadOnly { get; }
- bool HideCreateEntity { get; }
- bool HideCreateOrUpdateAllEntity { get; }
- bool HideCreateOrUpdateEntity { get; }
- bool HideDeleteAllEntity { get; }
- bool HideDeleteEntity { get; }
- bool HideGetEntity { get; }
- bool HideGetEntityForUpdate { get; }
- bool HideUpdateEntity { get; }
- IEntityAttribute IdentifierAttribute { get; set; }
- IIdentifierType IdentifierType { get; }
- bool IsStaticEntity { get; }
- string LogicalDatabase { get; set; }
- string Name { get; set; }
- bool SourceCodeExcluded { get; }
- string TableOrViewDefaultName { get; set; }
- IEntityAttribute CreateAttribute(string name = null, IKey key = null)

### interface IEntityAttribute : IAttribute, IExtensionObject
- IBasicType DataType { get; set; }
- int? Decimals { get; set; }
- string DefaultValue { get; }
- DeleteRule DeleteRule { get; set; }
- string Description { get; set; }
- IEntityAttributeDescriptor Descriptor { get; }
- bool IsAutoNumber { get; set; }
- bool IsIgnored { get; set; }
- bool IsMandatory { get; set; }
- int? Length { get; set; }
- string Name { get; set; }
- string OriginalName { get; set; }
- string OriginalType { get; set; }
- void SetDefaultValue(string value)

### interface IEntityAttributeDescriptor : IAttributeDescriptor
- IProperty DecimalsProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DeleteRuleProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsAutoNumberProperty { get; }
- IProperty IsIgnoredProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LengthProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalTypeProperty { get; }

### interface IEntityDescriptor : IRecordTypeDescriptor
- IChildCollection<IEntity, IEntityAttribute> AttributesChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty IdentifierAttributeProperty { get; }
- IChildCollection<IEntity, IIdentifierType> IdentifierTypeChildCollection { get; }
- IProperty IsStaticEntityProperty { get; }
- IProperty LogicalDatabaseProperty { get; }
- IProperty NameProperty { get; }
- IProperty TableOrViewDefaultNameProperty { get; }

### interface IExtension : IModule
- IEnumerable<IAction> Actions { get; }
- IEnumerable<IAnonymousStructure> AnonymousStructures { get; }
- string AppName { get; set; }
- IBasicType BinaryDataType { get; }
- IBasicType BooleanType { get; }
- CreatedByTool CreatedByTool { get; set; }
- IBasicType CurrencyType { get; }
- IBasicType DateTimeType { get; }
- IBasicType DateType { get; }
- IBasicType DecimalType { get; }
- IExtensionDescriptor Descriptor { get; }
- IBasicType EmailType { get; }
- IEnumerable<IEntity> Entities { get; }
- ExtensionKind ExtensionKind { get; }
- IBasicType FileType { get; }
- string Hash { get; }
- Byte[] Icon { get; set; }
- IBasicType IntegerIdentifierType { get; }
- IBasicType IntegerType { get; }
- Version LastUpgradeVersion { get; }
- IEnumerable<IListType> ListTypes { get; }
- IBasicType LongIntegerIdentifierType { get; }
- IBasicType LongIntegerType { get; }
- IEnumerable<IMetadata> Metadata { get; }
- IModelFeaturesManager ModelFeaturesManager { get; }
- IType ObjectType { get; }
- IBasicType PhoneNumberType { get; }
- string ProviderType { get; set; }
- IEnumerable<IExtensionResource> Resources { get; }
- string RuntimeVersion { get; }
- Byte[] SignatureBinary { get; }
- Guid SignatureHash { get; }
- IEnumerable<IStructure> Structures { get; }
- IBasicType TextIdentifierType { get; }
- IBasicType TextType { get; }
- IBasicType TimeType { get; }
- IAction CreateAction(string name = null, IKey key = null)
- IEntity CreateEntity(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy = null, IKey key = null)
- IExtensionResource CreateResource(string filename, Byte[] content, IKey key = null)
- IStaticEntity CreateStaticEntity(string name = null, IKey key = null)
- IStructure CreateStructure(string name = null, IKey key = null)
- IType GetExtensionType(Type cSharpType)
- IAnonymousStructure GetOrCreateAnonymousStructure(IEnumerable<Tuple<string, IType>> attributes)
- IAnonymousStructure GetOrCreateAnonymousStructure(Tuple<string, IType>[] attributes)
- IListType GetOrCreateListType(IType elementType)

### interface IExtensionDescriptor : IModuleDescriptor
- IChildCollection<IExtension, IAction> ActionsChildCollection { get; }
- IChildCollection<IExtension, IAnonymousStructure> AnonymousStructuresChildCollection { get; }
- IChildCollection<IExtension, IEntity> EntitiesChildCollection { get; }
- IChildCollection<IExtension, IListType> ListTypesChildCollection { get; }
- IChildCollection<IExtension, IMetadata> MetadataChildCollection { get; }
- IChildCollection<IExtension, IExtensionResource> ResourcesChildCollection { get; }
- IChildCollection<IExtension, IStructure> StructuresChildCollection { get; }

### interface IExtensionObject : IModelObject
- IEnumerable<IMetadata> Metadata { get; }
- IKey ObjectKey { get; }
- T CreateMetadata<T>(string name, string managedBy = null, IKey key = null)
- IExtension GetExtension()

### interface IExtensionResource : IExtensionObject
- Byte[] Content { get; set; }
- DeployAction DeployAction { get; set; }
- string Description { get; set; }
- IExtensionResourceDescriptor Descriptor { get; }
- string Filename { get; set; }
- string Path { get; set; }

### interface IExtensionResourceDescriptor : IClassDescriptor
- IProperty ContentProperty { get; }
- IProperty DeployActionProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FilenameProperty { get; }
- IProperty PathProperty { get; }

### interface IIdentifierType : IBasicType
- IIdentifierTypeDescriptor Descriptor { get; }
- IEntitySignature Entity { get; }

### interface IIdentifierTypeDescriptor : IBasicTypeDescriptor

### interface IInputParameter : IParameter
- IInputParameterDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }

### interface IInputParameterDescriptor : IClassDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty NameProperty { get; }

### interface IListType : IType
- IListTypeDescriptor Descriptor { get; }
- ITypeSignature ElementType { get; }

### interface IListTypeDescriptor : IClassDescriptor
- IProperty ElementTypeProperty { get; }

### interface IOutputParameter : IParameter
- IOutputParameterDescriptor Descriptor { get; }

### interface IOutputParameterDescriptor : IClassDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface IParameter : IExtensionObject
- IType DataType { get; set; }
- string Description { get; set; }
- string IntegrationName { get; set; }
- string Name { get; set; }
- void SetDefaultValue(string value)

### interface IRecordType : IType
- IEnumerable<IAttribute> Attributes { get; }

### interface IRecordTypeDescriptor : IClassDescriptor
- IChildCollection AttributesChildCollection { get; }

### interface IShareableExtensionObject : IExtensionObject, IShareable

### interface IShareableExtensionObject<ConcreteT, SignatureT> : IShareableExtensionObject

### interface IStaticEntity : IEntity
- IStaticEntityDescriptor Descriptor { get; }
- ISequence<IStaticEntityRecord> Records { get; }
- IStaticEntityRecord CreateRecord(string name = null, IKey key = null)

### interface IStaticEntityDescriptor : IEntityDescriptor
- IChildCollection<IStaticEntity, IStaticEntityRecord> RecordsChildCollection { get; }

### interface IStaticEntityRecord : IExtensionObject
- ISequence<IStaticRecordAttributeValue> AttributeValues { get; }
- IStaticEntityRecordDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- string Name { get; set; }

### interface IStaticEntityRecordDescriptor : IClassDescriptor
- IChildCollection<IStaticEntityRecord, IStaticRecordAttributeValue> AttributeValuesChildCollection { get; }
- IProperty IconProperty { get; }

### interface IStaticRecordAttributeValue : IExtensionObject
- IEntityAttribute Attribute { get; }
- IStaticRecordAttributeValueDescriptor Descriptor { get; }
- string Value { get; }
- void SetValue(string value)

### interface IStaticRecordAttributeValueDescriptor : IClassDescriptor
- IProperty AttributeProperty { get; }
- IProperty ValueProperty { get; }

### interface IStructure : IRecordType, IShareableExtensionObject<IStructure, IStructureSignature>
- ISequence<IStructureAttribute> Attributes { get; }
- string Description { get; set; }
- IStructureDescriptor Descriptor { get; }
- string FullTypeName { get; set; }
- string IntegrationName { get; set; }
- bool IsPlainStructure { get; set; }
- string Name { get; set; }
- IStructureAttribute CreateAttribute(string name = null, IKey key = null)

### interface IStructureAttribute : IAttribute, IExtensionObject
- IType DataType { get; set; }
- int? Decimals { get; set; }
- string DefaultValue { get; }
- string Description { get; set; }
- IStructureAttributeDescriptor Descriptor { get; }
- string IntegrationName { get; set; }
- bool IsMandatory { get; set; }
- int? Length { get; set; }
- string Name { get; set; }
- void SetDefaultValue(string value)

### interface IStructureAttributeDescriptor : IAttributeDescriptor
- IProperty DecimalsProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LengthProperty { get; }

### interface IStructureDescriptor : IRecordTypeDescriptor
- IChildCollection<IStructure, IStructureAttribute> AttributesChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface IType : IExtensionObject

## OutSystems.Model.Extensions.Metadata

### interface IMetadata : IModelObject
- string ManagedBy { get; }
- string Name { get; }

### interface ITextMetadata : IMetadata
- ITextMetadataDescriptor Descriptor { get; }
- string Value { get; set; }

### interface ITextMetadataDescriptor : IClassDescriptor
- IProperty NameProperty { get; }
- IProperty ValueProperty { get; }

## OutSystems.Model.ExternalLibraries

### interface IAction : IShareableExternalLibraryObject<IAction, IServerActionSignature>
- IActionDescriptor Descriptor { get; }
- bool Function { get; set; }
- Byte[] Icon { get; set; }
- IEnumerable<IParameter> Parameters { get; }
- IOutputParameter ReturnValue { get; set; }

### interface IActionDescriptor : IExternalLibraryObjectDescriptor
- IProperty FunctionProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection ParametersChildCollection { get; }
- IProperty ReturnValueProperty { get; }

### interface IExternalLibrary : IModule
- IEnumerable<IAction> Actions { get; }
- IBasicType BinaryDataType { get; }
- IBasicType BooleanType { get; }
- string ClassName { get; set; }
- IEnumerable<string> ConstructorParameters { get; set; }
- IBasicType CurrencyType { get; }
- IBasicType DateTimeType { get; }
- IBasicType DateType { get; }
- IBasicType DecimalType { get; }
- string Description { get; set; }
- IExternalLibraryDescriptor Descriptor { get; }
- IBasicType EmailType { get; }
- IBasicType FileType { get; }
- Byte[] Icon { get; set; }
- IBasicType IntegerIdentifierType { get; }
- IBasicType IntegerType { get; }
- string InterfaceName { get; set; }
- IEnumerable<IListType> ListTypes { get; }
- IBasicType LongIntegerIdentifierType { get; }
- IBasicType LongIntegerType { get; }
- string Name { get; set; }
- IType ObjectType { get; }
- IBasicType PhoneNumberType { get; }
- IEnumerable<IResource> Resources { get; }
- RuntimeMajor RuntimeVersion { get; set; }
- Byte[] SignatureBinary { get; }
- Guid SignatureHash { get; }
- IEnumerable<IStructure> Structures { get; }
- IBasicType TextIdentifierType { get; }
- IBasicType TextType { get; }
- IBasicType TimeType { get; }
- IType GetLibraryType(Type type)
- IListType GetOrCreateListType(IType elementType)

### interface IExternalLibraryDescriptor : IModuleDescriptor
- IChildCollection<IExternalLibrary, IAction> ActionsChildCollection { get; }
- IChildCollection<IExternalLibrary, IListType> ListTypesChildCollection { get; }
- IChildCollection<IExternalLibrary, IResource> ResourcesChildCollection { get; }
- IChildCollection<IExternalLibrary, IStructure> StructuresChildCollection { get; }

### interface IExternalLibraryObject : IModelObject
- string Description { get; set; }
- IExternalLibrary ExternalLibrary { get; }
- string Name { get; set; }

### interface IExternalLibraryObjectDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface IInputParameter : IParameter
- string DefaultValue { get; set; }
- IInputParameterDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }

### interface IInputParameterDescriptor : IParameterDescriptor
- IProperty DefaultValueProperty { get; }
- IProperty IsMandatoryProperty { get; }

### interface IListType : IType
- IListTypeDescriptor Descriptor { get; }
- IType ElementType { get; }

### interface IListTypeDescriptor : IClassDescriptor
- IProperty ElementTypeProperty { get; }

### interface IOutputParameter : IParameter
- IOutputParameterDescriptor Descriptor { get; }

### interface IOutputParameterDescriptor : IParameterDescriptor

### interface IParameter : IModelObject
- IType DataType { get; set; }
- string Description { get; set; }
- IParameterDescriptor Descriptor { get; }
- string HighCodeType { get; set; }
- string Name { get; set; }

### interface IParameterDescriptor : IClassDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty HighCodeTypeProperty { get; }
- IProperty NameProperty { get; }

### interface IResource : IModelObject
- Byte[] Content { get; set; }
- string Description { get; set; }
- IResourceDescriptor Descriptor { get; }
- string Filename { get; set; }
- string Path { get; set; }

### interface IResourceDescriptor : IClassDescriptor
- IProperty ContentProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FilenameProperty { get; }
- IProperty PathProperty { get; }

### interface IShareableExternalLibraryObject : IExternalLibraryObject, IShareable

### interface IShareableExternalLibraryObject<ConcreteT, SignatureT> : IShareableExternalLibraryObject

### interface IStructure : IShareableExternalLibraryObject<IStructure, IStructureSignature>, IType
- ISequence<IStructureAttribute> Attributes { get; }
- IStructureDescriptor Descriptor { get; }

### interface IStructureAttribute : IModelObject
- IType DataType { get; set; }
- int? Decimals { get; set; }
- string DefaultValue { get; }
- string Description { get; set; }
- IStructureAttributeDescriptor Descriptor { get; }
- string HighCodeType { get; set; }
- bool IsMandatory { get; set; }
- int? Length { get; set; }
- string Name { get; set; }

### interface IStructureAttributeDescriptor : IClassDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DecimalsProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty HighCodeTypeProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LengthProperty { get; }
- IProperty NameProperty { get; }

### interface IStructureDescriptor : IClassDescriptor
- IChildCollection AttributesChildCollection { get; }

## OutSystems.Model.Factory

### static class FactoryExtensions
- IModelObject CreateChild(IModelObject parent, ModelObjectDefinition childDefinition, IObjectResolver objResolver)
- IModelObject CreateChild(IModelObject parent, ModelObjectDefinition childDefinition, IObjectResolver objResolver, FactoryOptions options)
- IModelObject CreateChild(IModelObject parent, Type childType, IChildCollection childCollection = null, string name = null, IKey key = null)
- IModelObject CreateChild(IModelObject parent, Type childType, IChildCollection childCollection, string name, IKey key, FactoryOptions options)
- IModelObject CreateDetachedChild(IModelObject parent, ModelObjectDefinition childDefinition, IObjectResolver objResolver, FactoryOptions options = null)
- IModelObject CreateDetachedChild(IModelObject parent, Type childType, IChildCollection childCollection, string name, IKey key, FactoryOptions options)
- T CreateDetachedClone<T>(T obj, IObjectResolver objResolver = null)
- IEnumerable<IModelObject> CreateOrTransformObjects(IESpace eSpace, IObjectResolver objResolver, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, ModelObjectDefinition>> specs)
- IEnumerable<IModelObject> CreateOrTransformObjects(IESpace eSpace, IObjectResolver objResolver, ValueTuple<IObjectSignature, IObjectSignature, ModelObjectDefinition>[] specs)
- IEnumerable<IModelObject> CreateOrTransformObjects(IESpace eSpace, IObjectResolver objResolver, IEnumerable<ValueTuple<IObjectSignature, IObjectSignature, ModelObjectDefinition>> specs, FactoryOptions options)
- IEnumerable<IModelObject> CreateOrTransformObjects(IESpace eSpace, IObjectResolver objResolver, FactoryOptions options, ValueTuple<IObjectSignature, IObjectSignature, ModelObjectDefinition>[] specs)
- string GetTargetPath(IModelObject obj)
- IModelObject ResolveTargetPath(IModelObject root, string path)
- ModelObjectDefinition ToModelObjectDefinition(IModelObject obj, ModelObjectDefinition parent = null, ModelObjectDefinitionOptions options = null)
- ModelObjectDefinition ToModelObjectDefinition(IModelObject obj, ModelObjectDefinition parent, bool useUniqueIdForAnonymousTypes, bool useReadableIdentifiersInsteadOfKeys, bool useDeterministicOrder)
- IModelObject Transform(IModelObject obj, ModelObjectDefinition newDefinition, IObjectResolver objResolver, FactoryOptions options = null)
- IModelObject Transform(IModelObject obj, ModelObjectDefinition newDefinition, IObjectResolver objResolver, bool keysMustBeRespected)

### class FactoryOptions
- FactoryOptions Default { get; }
- bool KeysMustBeRespected { get; set; }
- bool RaiseExceptionForUnresolvedProperties { get; set; }
- bool UsesMerge { get; set; }

### interface IObjectResolver
- IEnumerable<IModelObject> Lookup(string name)
- bool TryLookup(IKey key, out IModelObject obj)
- bool TryLookup(IGlobalKey key, out IModelObject obj)

### class ModelObjectDefinition
- IChildCollection ChildCollection { get; }
- ReadOnlyDictionary<IChildCollection, IEnumerable<ModelObjectDefinition>> Children { get; }
- IClassDescriptor Descriptor { get; }
- IKey Key { get; set; }
- Type ObjectType { get; }
- ModelObjectDefinition Parent { get; }
- Dictionary<IProperty, object> Properties { get; }
- void AddEmptyChildCollection(IChildCollection childCollection)
- void Discard()
- void Move(ModelObjectDefinition newParent, IChildCollection childCollectionInNewParent)

### static class ModelObjectDefinitionExtensions
- string Serialize(ModelObjectDefinition def, Func<IKey, string> serializeKey = null, Func<IGlobalKey, string> serializeGlobalKey = null)
- string Serialize(IEnumerable<ModelObjectDefinition> defs, Func<IKey, string> serializeKey = null, Func<IGlobalKey, string> serializeGlobalKey = null)
- void WriteProperty(Utf8JsonWriter writer, string name, object value, Func<IKey, string> serializeKey, Func<IGlobalKey, string> serializeGlobalKey)

### class ModelObjectDefinitionOptions
- ModelObjectDefinitionOptions Default { get; }
- bool SkipChildren { get; set; }
- bool UseDeterministicOrder { get; set; }
- bool UseReadableIdentifiersInsteadOfKeys { get; set; }
- bool UsesMerge { get; set; }
- bool UseUniqueIdForAnonymousTypes { get; set; }

## OutSystems.Model.Factory.ChangeSet

### interface IDescriptorThatSupportsAdditionalChildCollections
- IEnumerable<IChildCollection> ExtraChildCollectionsSupported { get; }

### interface IDescriptorThatSupportsAdditionalProperties
- IEnumerable<IProperty> ExtraPropertiesSupported { get; }

## OutSystems.Model.Logic

### interface IAction : IActionSignature, IFlow
- IActionDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- ISequence<ILocalVariable> LocalVariables { get; }
- IEnumerable<IActionNode> Nodes { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)

### interface IActionConnector : IConnector
- IActionConnectorDescriptor Descriptor { get; }
- IActionNode Source { get; }
- IActionNode Target { get; set; }

### interface IActionConnectorDescriptor : IConnectorDescriptor

### interface IActionDescriptor : IActionSignatureDescriptor, IFlowDescriptor
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection NodesChildCollection { get; }

### interface IActionHandler : IObject
- IActionSignature Action { get; set; }
- IEnumerable<IAIArgument> Arguments { get; }
- string Description { get; set; }
- IActionHandlerDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IActionHandlerDescriptor : IObjectDescriptor
- IProperty ActionProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IActionSignature : IFlowSignature
- IActionSignatureDescriptor Descriptor { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- IEnumerable<IOutputParameterSignature> OutputParameters { get; }

### interface IActionSignatureDescriptor : IFlowSignatureDescriptor
- IChildCollection InputParametersChildCollection { get; }
- IChildCollection OutputParametersChildCollection { get; }

### interface IAgent : IObject
- ISequence<IActionHandler> ActionHandlers { get; }
- IServerActionSignature AIModel { get; set; }
- IExpression CallCondition { get; }
- string Description { get; set; }
- IAgentDescriptor Descriptor { get; }
- bool EnableActionCalling { get; set; }
- IExpression ExtraBody { get; }
- IFolder Folder { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- IExpression MaxTokens { get; }
- IExpression Messages { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IStructureSignature OutputFormat { get; set; }
- string OutputFormatDescription { get; set; }
- IExpression Stop { get; }
- IExpression Temperature { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IActionHandler CreateActionHandler(IKey key = null)
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- string GetOutputFormatAttributeDescription(IAttributeSignature attribute)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetCallCondition(ExpressionDefinition value)
- void SetExtraBody(ExpressionDefinition value)
- void SetMaxTokens(ExpressionDefinition value)
- void SetMessages(ExpressionDefinition value)
- void SetOutputFormatAttributeDescription(IAttributeSignature attribute, string description)
- void SetStop(ExpressionDefinition value)
- void SetTemperature(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAgentDescriptor : IObjectDescriptor
- IChildCollection ActionHandlersChildCollection { get; }
- IProperty AIModelProperty { get; }
- IExpressionProperty CallConditionProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EnableActionCallingProperty { get; }
- IExpressionProperty ExtraBodyProperty { get; }
- IProperty FolderProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IExpressionProperty MaxTokensProperty { get; }
- IExpressionProperty MessagesProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty OutputFormatDescriptionProperty { get; }
- IProperty OutputFormatProperty { get; }
- IExpressionProperty StopProperty { get; }
- IExpressionProperty TemperatureProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IAgentManifest : IAgentManifestSignature, IShareableESpaceObject<IAgentManifest, IAgentManifestSignature>
- IServerActionSignature AIModel { get; set; }
- ISequence<IAIModelSetting> AIModelSettings { get; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- IAgentManifestDescriptor Descriptor { get; }
- string GoalsAndInstructions { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- ISequence<IKnowledgeBaseReference> KnowledgeBaseReferences { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IMemory Memory { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- ISequence<ISkillReference> SkillReferences { get; }
- IEnumerable<ITextResource> TextResources { get; }
- ISequence<IToolReference> ToolReferences { get; }
- IAIModelSetting CreateAIModelSetting(string name = null, IKey key = null)
- IEventToolReference CreateEventToolReference(string name = null, IKey key = null)
- IExternalLibraryToolReference CreateExternalLibraryToolReference(string name = null, IKey key = null)
- IKnowledgeBaseReference CreateKnowledgeBaseReference(string name = null, IKey key = null)
- IMCPToolReference CreateMCPToolReference(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IServiceActionToolReference CreateServiceActionToolReference(string name = null, IKey key = null)
- ISkillReference CreateSkillReference(string name = null, IKey key = null)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAgentManifestDescriptor : IAgentManifestSignatureDescriptor, IObjectDescriptor
- IProperty AIModelProperty { get; }
- IChildCollection AIModelSettingsChildCollection { get; }
- IProperty GoalsAndInstructionsProperty { get; }
- IChildCollection KnowledgeBaseReferencesChildCollection { get; }
- IChildCollection MemoryChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection SkillReferencesChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IChildCollection ToolReferencesChildCollection { get; }

### interface IAgentManifestSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IAgentManifestSignatureDescriptor Descriptor { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IAgentManifestSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IAIModelSetting : IObject
- IAIModelSettingDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- string Value { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAIModelSettingDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty ValueProperty { get; }

### interface IAppRole : IAppRoleSignature, IRole, IShareableESpaceObject<IAppRole, IAppRoleSignature>
- string CreatedBy { get; set; }
- IAppRoleDescriptor Descriptor { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAppRoleDescriptor : IAppRoleSignatureDescriptor, IRoleDescriptor
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IAppRoleSignature : IRoleSignature
- string CreatedBy { get; }
- IAppRoleSignatureDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IAppRoleSignatureDescriptor : IRoleSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IAssignment : IObject
- IAssignmentDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- IExpression Variable { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)

### interface IAssignmentDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface ICallback : IObject
- string CreatedBy { get; set; }
- ICallbackDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<IActionNode> Nodes { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ICallbackDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IClientAction : IAction, IClientActionSignature, IShareableESpaceObject<IClientAction, IClientActionSignature>
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IClientActionDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool Function { get; set; }
- Byte[] Icon { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }

### interface IClientActionDescriptor : IActionDescriptor, IClientActionSignatureDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IClientActionSignature : IActionSignature
- string CreatedBy { get; }
- string Description { get; }
- IClientActionSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- bool Function { get; }
- Byte[] Icon { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IClientActionSignatureDescriptor : IActionSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty FunctionProperty { get; }
- IProperty IconProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IEntityActionSignature : IActionSignature

### interface IEntityActionSignatureDescriptor : IActionSignatureDescriptor

### interface IEventToolReference : IToolReference
- IEventToolReferenceDescriptor Descriptor { get; }
- IGlobalEventSignature Event { get; set; }

### interface IEventToolReferenceDescriptor : IToolReferenceDescriptor
- IProperty EventProperty { get; }

### interface IException : IObject
- IExceptionDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IExceptionDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }

### interface IExternalLibraryToolReference : IToolReference
- IServerActionSignature Action { get; set; }
- IExternalLibraryToolReferenceDescriptor Descriptor { get; }

### interface IExternalLibraryToolReferenceDescriptor : IToolReferenceDescriptor
- IProperty ActionProperty { get; }

### interface IIntegrationReferenceAction : IServerActionSignature
- IReadOnlyList<KeyValuePair<string, string>> AdditionalInformation { get; }
- string IntegrationName { get; }

### interface IKnowledgeBaseReference : IObject
- IServerActionSignature Action { get; set; }
- IKnowledgeBaseReferenceDescriptor Descriptor { get; }
- bool Enabled { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IKnowledgeBaseReferenceDescriptor : IObjectDescriptor
- IProperty ActionProperty { get; }
- IProperty EnabledProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IMCPToolReference : IToolReference
- IServerActionSignature Action { get; set; }
- IMCPToolReferenceDescriptor Descriptor { get; }
- MCPToolReferenceKind MCPServerType { get; set; }

### interface IMCPToolReferenceDescriptor : IToolReferenceDescriptor
- IProperty ActionProperty { get; }
- IProperty MCPServerTypeProperty { get; }

### interface IMemory : IObject
- IMemoryDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- ISessionMemory SessionMemory { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IMemoryDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection SessionMemoryChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IOnSyncSystemEvent : ISystemEvent, ITriggerableEvent
- IOnSyncSystemEventDescriptor Descriptor { get; }

### interface IOnSyncSystemEventDescriptor : ISystemEventDescriptor

### interface IRole : IObject, IRoleSignature
- string Description { get; set; }
- IRoleDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool IsPersistent { get; set; }

### interface IRoleDescriptor : IObjectDescriptor, IRoleSignatureDescriptor

### interface IRoleException : IException
- IRoleExceptionDescriptor Descriptor { get; }
- IRoleSignature Role { get; }

### interface IRoleExceptionDescriptor : IExceptionDescriptor
- IProperty RoleProperty { get; }

### interface IRoleSignature : IObjectSignature
- IActionSignature CheckRoleAction { get; }
- IActionSignature CheckRoleClientSideAction { get; }
- string Description { get; }
- IRoleSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- IActionSignature GrantRoleAction { get; }
- bool IsPersistent { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IActionSignature RevokeRoleAction { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IRoleSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IsPersistentProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection RoleActionsChildCollection { get; }

### interface IServerAction : IAction, IServerActionSignature, IShareableESpaceObject<IServerAction, IServerActionSignature>
- int? CacheInMinutes { get; set; }
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IServerActionDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool Function { get; set; }
- Byte[] Icon { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }

### interface IServerActionDescriptor : IActionDescriptor, IServerActionSignatureDescriptor
- IProperty CacheInMinutesProperty { get; }
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IServerActionSignature : IActionSignature
- string CreatedBy { get; }
- string Description { get; }
- IServerActionSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- bool Function { get; }
- Byte[] Icon { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IServerActionSignatureDescriptor : IActionSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty FunctionProperty { get; }
- IProperty IconProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IServiceAction : IAction, IServiceActionSignature, IShareableESpaceObject<IServiceAction, IServiceActionSignature>
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IServiceActionDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- Byte[] Icon { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }

### interface IServiceActionDescriptor : IActionDescriptor, IServiceActionSignatureDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IServiceActionSignature : IActionSignature
- string CreatedBy { get; }
- string Description { get; }
- IServiceActionSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- Byte[] Icon { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IServiceActionSignatureDescriptor : IActionSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IconProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IServiceActionToolReference : IToolReference
- IServiceActionToolReferenceDescriptor Descriptor { get; }
- IServiceActionSignature ServiceAction { get; set; }

### interface IServiceActionToolReferenceDescriptor : IToolReferenceDescriptor
- IProperty ServiceActionProperty { get; }

### interface ISessionMemory : IObject
- ISessionMemoryDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- int RetentionDays { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- int TokenLimit { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISessionMemoryDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty RetentionDaysProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TokenLimitProperty { get; }

### interface ISkillReference : IObject
- ISkillReferenceDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- string SkillResourceId { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- string Version { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISkillReferenceDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty SkillResourceIdProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty VersionProperty { get; }

### interface ISQLInputParameter : IInputParameter
- string CreatedBy { get; set; }
- ISQLInputParameterDescriptor Descriptor { get; }
- bool ExpandInline { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISQLInputParameterDescriptor : IInputParameterDescriptor
- IProperty CreatedByProperty { get; }
- IProperty ExpandInlineProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ISQLOutput : IObject
- string CreatedBy { get; set; }
- ISQLOutputDescriptor Descriptor { get; }
- IRecordTypeSignature EntityOrStructure { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISQLOutputDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty EntityOrStructureProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ISystemEvent : IActionSignature, IFlow
- ISystemEventDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- ISequence<ILocalVariable> LocalVariables { get; }
- IEnumerable<IActionNode> Nodes { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)

### interface ISystemEventDescriptor : IActionSignatureDescriptor, IFlowDescriptor
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection NodesChildCollection { get; }

### interface ISystemException : IException
- ISystemExceptionDescriptor Descriptor { get; }

### interface ISystemExceptionDescriptor : IExceptionDescriptor

### interface ISystemRole : IRole
- ISystemRoleDescriptor Descriptor { get; }

### interface ISystemRoleDescriptor : IRoleDescriptor

### interface IToolReference : IObject
- IEnumerable<IAIArgument> Arguments { get; }
- IToolReferenceDescriptor Descriptor { get; }
- bool Enabled { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- bool RequireApproval { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IToolReferenceAction : IIntegrationReferenceAction
- string ToolSchema { get; }

### interface IToolReferenceDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty EnabledProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty RequireApprovalProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ITriggerableEvent : IModelObject

### interface IUserException : IException
- string CreatedBy { get; set; }
- IUserExceptionDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IUserExceptionDescriptor : IExceptionDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

## OutSystems.Model.Logic.Aggregates

### interface IAggregate : IObject
- IDatabaseAggregate AsDatabaseAggregate { get; }
- IFullAggregate AsFullAggregate { get; }
- int? CacheInMinutes { get; set; }
- string Description { get; set; }
- IAggregateDescriptor Descriptor { get; }
- ISequence<IImplicitParameter> ImplicitParameters { get; }
- bool IsClientSide { get; }
- IExpression MaxRecords { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IExpression StartIndex { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- int? Timeout { get; set; }
- ITypeSignature Type { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetMaxRecords(ExpressionDefinition value)
- void SetStartIndex(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAggregatedAttribute : IObject
- AggregationType AggregationType { get; set; }
- IExpression Attribute { get; }
- ITypeSignature DataType { get; }
- IAggregatedAttributeDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetAttribute(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IAggregatedAttributeDescriptor : IObjectDescriptor
- IProperty AggregationTypeProperty { get; }
- IExpressionProperty AttributeProperty { get; }
- IProperty DataTypeProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IAggregateDescriptor : IObjectDescriptor
- IProperty CacheInMinutesProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection ImplicitParametersChildCollection { get; }
- IProperty IsClientSideProperty { get; }
- IExpressionProperty MaxRecordsProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IAggregate, IOperation> OperationsChildCollection { get; }
- IProperty RootOperationProperty { get; }
- IExpressionProperty StartIndexProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TimeoutProperty { get; }
- IProperty TypeProperty { get; }

### interface ICalculatedAttribute : IObject
- ITypeSignature DataType { get; }
- ICalculatedAttributeDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)
- void SetValue(ExpressionDefinition value)

### interface ICalculatedAttributeDescriptor : IObjectDescriptor
- IProperty DataTypeProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IExpressionProperty ValueProperty { get; }

### interface IDataSource : IModelObject

### interface IFilter : IObject
- IExpression Condition { get; }
- IFilterDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetCondition(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IFilterDescriptor : IObjectDescriptor
- IExpressionProperty ConditionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IGroupByAttribute : IObject
- IExpression Attribute { get; }
- IGroupByAttributeDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetAttribute(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IGroupByAttributeDescriptor : IObjectDescriptor
- IExpressionProperty AttributeProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IImplicitParameter : IObject
- IImplicitParameterDescriptor Descriptor { get; }
- string InferredName { get; }
- ISequence<IMetadata> Metadata { get; }
- IExpression TestValue { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- ITypeSignature Type { get; }
- IExpression Value { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTestValue(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IImplicitParameterDescriptor : IObjectDescriptor
- IProperty InferredNameProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IExpressionProperty TestValueProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TypeProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface ISort : IObject
- IExpression Attribute { get; }
- ISortDescriptor Descriptor { get; }
- bool IsDynamic { get; set; }
- ISequence<IMetadata> Metadata { get; }
- Sort SortDirection { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetAttribute(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISortDescriptor : IObjectDescriptor
- IExpressionProperty AttributeProperty { get; }
- IProperty IsDynamicProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty SortDirectionProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

## OutSystems.Model.Logic.Aggregates.Database

### interface IAliasedSource : IObject
- ICollection<IAttributeSignature> AttributesInPreview { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IDataSource Source { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- int GetAttributeDisplayOrder(IAttributeSignature attribute)
- bool GetAttributeVisibility(IAttributeSignature attribute)
- void SetAttributeDisplayOrder(IAttributeSignature attribute, int displayOrder)
- void SetAttributeVisibility(IAttributeSignature attribute, bool isVisible)

### interface IAliasedSourceDescriptor : IObjectDescriptor
- IChildCollection AttributesInPreviewChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty SourceProperty { get; }

### interface IDatabaseAggregate : IAggregate
- IEnumerable<IAggregatedAttribute> AggregatedAttributes { get; }
- IEnumerable<ICalculatedAttribute> CalculatedAttributes { get; }
- IEnumerable<ICalculatedAttribute> CalculatedAttributesInGroupBy { get; }
- ISequence<IFilter> Filters { get; }
- ISequence<IFilter> FiltersInGroupBy { get; }
- IEnumerable<IGroupByAttribute> GroupByAttributes { get; }
- ISequence<IJoin> Joins { get; }
- IAliasedSource MasterSource { get; }
- ISequence<ISort> Sorts { get; }
- ISequence<ISort> SortsInGroupBy { get; }
- IEnumerable<IAliasedSource> Sources { get; }
- IAggregatedAttribute CreateAggregatedAttribute(string name = null, IKey key = null)
- IAggregatedAttribute CreateAggregatedAttribute(string name, IAttributeSignature attribute, AggregationType aggregationType, IKey key = null)
- ICalculatedAttribute CreateCalculatedAttribute(string name = null, IKey key = null)
- ICalculatedAttribute CreateCalculatedAttributeInGroupBy(string name = null, IKey key = null)
- IFilter CreateFilter(string condition = null, IKey key = null)
- IFilter CreateFilterInGroupBy(string condition = null, IKey key = null)
- IGroupByAttribute CreateGroupByAttribute(string name = null, IKey key = null)
- IGroupByAttribute CreateGroupByAttribute(string name, IAttributeSignature attribute, IKey key = null)
- IJoin CreateJoin(IKey key = null)
- ISort CreateSort(IKey key = null)
- ISort CreateSortInGroupBy(IKey key = null)
- IAliasedSource CreateSource(IDataSource dataSource, string name = null, IKey key = null)

### interface IJoin : IObject
- IExpression Condition { get; }
- JoinType JoinType { get; set; }
- IAliasedSource LeftSource { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IAliasedSource RightSource { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void SetCondition(string value)

## OutSystems.Model.Logic.Aggregates.Full

### interface IAddSourceOperation : IOperation
- ICollection<IAttributeSignature> AttributesInPreview { get; }
- IAddSourceOperationDescriptor Descriptor { get; }
- string Name { get; }
- IDataSource Source { get; set; }
- int GetAttributeDisplayOrder(IAttributeSignature attribute)
- bool GetAttributeVisibility(IAttributeSignature attribute)
- void SetAttributeDisplayOrder(IAttributeSignature attribute, int displayOrder)
- void SetAttributeVisibility(IAttributeSignature attribute, bool isVisible)

### interface IAddSourceOperationDescriptor : IOperationDescriptor
- IProperty SourceProperty { get; }

### interface IAliasedSource : IObject
- IAliasedSourceDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IOperation SourceOperation { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IAliasedSourceDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty SourceOperationProperty { get; }

### interface ICombineSourcesOperation : IOperation
- IEnumerable<ICalculatedAttribute> CalculatedAttributes { get; }
- ICombineSourcesOperationDescriptor Descriptor { get; }
- ISequence<IFilter> Filters { get; }
- ISequence<IJoin> Joins { get; }
- string Name { get; set; }
- ISequence<ISort> Sorts { get; }
- IEnumerable<IAliasedSource> Sources { get; }
- ICalculatedAttribute CreateCalculatedAttribute(string name = null, IKey key = null)
- IFilter CreateFilter(IKey key = null)
- IJoin CreateJoin(IKey key = null)
- ISort CreateSort(IKey key = null)
- IAliasedSource CreateSource(IDataSource dataSource, string name = null)
- IAliasedSource CreateSource(string name = null, IKey key = null)

### interface ICombineSourcesOperationDescriptor : IOperationDescriptor
- IChildCollection CalculatedAttributesChildCollection { get; }
- IChildCollection FiltersChildCollection { get; }
- IChildCollection JoinsChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection SortsChildCollection { get; }
- IChildCollection SourcesChildCollection { get; }

### interface IFullAggregate : IAggregate
- IEnumerable<IOperation> Operations { get; }
- IOperation RootOperation { get; set; }
- IAddSourceOperation CreateAddSourceOperation(IDataSource dataSource)
- ICombineSourcesOperation CreateCombineSourcesOperation()
- IGroupByOperation CreateGroupByOperation()

### interface IGroupByOperation : IOperation
- IEnumerable<IAggregatedAttribute> AggregatedAttributes { get; }
- IGroupByOperationDescriptor Descriptor { get; }
- IEnumerable<IGroupByAttribute> GroupByAttributes { get; }
- IOperation SourceOperation { get; set; }
- IAggregatedAttribute CreateAggregatedAttribute(string name = null, IKey key = null)
- IGroupByAttribute CreateGroupByAttribute(string name = null, IKey key = null)

### interface IGroupByOperationDescriptor : IOperationDescriptor
- IChildCollection AggregatedAttributesChildCollection { get; }
- IChildCollection GroupByAttributesChildCollection { get; }
- IProperty SourceOperationProperty { get; }

### interface IJoin : IObject
- IExpression Condition { get; }
- IJoinDescriptor Descriptor { get; }
- JoinType JoinType { get; set; }
- IAliasedSource LeftSource { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IAliasedSource RightSource { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetCondition(ExpressionDefinition value)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IJoinDescriptor : IObjectDescriptor
- IExpressionProperty ConditionProperty { get; }
- IProperty JoinTypeProperty { get; }
- IProperty LeftSourceProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty RightSourceProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IOperation : IObject
- IOperationDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IOperationDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

## OutSystems.Model.Logic.Integrations

### interface IClient : IIntegration
- IEnumerable<IConsumedAction> Actions { get; }
- IClientDescriptor Descriptor { get; }
- IEnumerable<IStaticEntity> StaticEntities { get; }

### interface IClientDescriptor : IIntegrationDescriptor
- IChildCollection ActionsChildCollection { get; }
- IChildCollection StaticEntitiesChildCollection { get; }

### interface IConsumedAction : IActionSignature
- int? CacheInMinutes { get; set; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- IConsumedActionDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExtendedProperty CreateExtendedProperty()
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IConsumedActionDescriptor : IActionSignatureDescriptor
- IProperty CacheInMinutesProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IExposedAction : IAction
- IExposedActionDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExtendedProperty CreateExtendedProperty()

### interface IExposedActionDescriptor : IActionDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }

### interface IIntegration : IObject
- IEnumerable<IPluginCallback> Callbacks { get; }
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IIntegrationDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- Byte[] Icon { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- string Name { get; set; }
- IEnumerable<IStructure> Structures { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IExtendedProperty CreateExtendedProperty()
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IIntegrationDescriptor : IObjectDescriptor
- IChildCollection CallbacksChildCollection { get; }
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty IconProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection StructuresChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IPluginCallback : IAction
- IPluginCallbackDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExtendedProperty CreateExtendedProperty()

### interface IPluginCallbackDescriptor : IActionDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }

### interface IService : IIntegration
- IEnumerable<IExposedAction> Actions { get; }
- IServiceDescriptor Descriptor { get; }

### interface IServiceDescriptor : IIntegrationDescriptor
- IChildCollection ActionsChildCollection { get; }

## OutSystems.Model.Logic.Integrations.SOAP

### interface ISOAPClient : IObject
- IEnumerable<ISOAPClientAction> Actions { get; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- ISOAPClientDescriptor Descriptor { get; }
- string Endpoint { get; }
- IEnumerable<ISOAPClientExternalSchema> ExternalSchemas { get; }
- IEnumerable<ISOAPClientImport> Imports { get; }
- bool IntegratedAuthentication { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- string OriginalDescription { get; }
- string OriginalName { get; }
- string Prefix { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- string URL { get; }
- bool UsesOldStyleChoice { get; set; }
- bool UsesOldStyleEnums { get; set; }
- IEnumerable<IStructure> WebReferenceStructures { get; }
- string WSDL { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISOAPClientAction : IActionSignature
- int? CacheInMinutes { get; set; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- ISOAPClientActionDescriptor Descriptor { get; }
- bool Function { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string OriginalDescription { get; }
- string OriginalName { get; }
- string OriginalWSDLName { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- int? TimeoutInSeconds { get; set; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISOAPClientActionDescriptor : IActionSignatureDescriptor
- IProperty CacheInMinutesProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FunctionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalWSDLNameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TimeoutInSecondsProperty { get; }

### interface ISOAPClientDescriptor : IObjectDescriptor
- IChildCollection ActionsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EndpointProperty { get; }
- IChildCollection ExternalSchemasChildCollection { get; }
- IChildCollection ImportsChildCollection { get; }
- IProperty IntegratedAuthenticationProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty PrefixProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty URLProperty { get; }
- IProperty UsesOldStyleChoiceProperty { get; }
- IProperty UsesOldStyleEnumsProperty { get; }
- IChildCollection WebReferenceStructuresChildCollection { get; }
- IProperty WSDLProperty { get; }

### interface ISOAPClientExternalSchema : IObject
- string Content { get; }
- ISOAPClientExternalSchemaDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- string URL { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISOAPClientExternalSchemaDescriptor : IObjectDescriptor
- IProperty ContentProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty URLProperty { get; }

### interface ISOAPClientImport : ISOAPClientExternalSchema
- ISOAPClientImportDescriptor Descriptor { get; }

### interface ISOAPClientImportDescriptor : ISOAPClientExternalSchemaDescriptor

### interface ISOAPService : IObject
- IEnumerable<ISOAPServiceAction> Actions { get; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- ISOAPServiceDescriptor Descriptor { get; }
- HTTPSecurityWithCertificates HTTPSecurity { get; set; }
- bool IntegratedAuthentication { get; set; }
- bool InternalAccessOnly { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- ISOAPServiceAction CreateAction(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ISOAPServiceAction : IAction
- ISOAPServiceActionDescriptor Descriptor { get; }

### interface ISOAPServiceActionDescriptor : IActionDescriptor

### interface ISOAPServiceDescriptor : IObjectDescriptor
- IChildCollection ActionsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty HTTPSecurityProperty { get; }
- IProperty IntegratedAuthenticationProperty { get; }
- IProperty InternalAccessOnlyProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

## OutSystems.Model.Logic.Mobile.Nodes

### interface ISendEmailNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- IExpression Attachments { get; }
- IExpression Bcc { get; }
- IExpression Cc { get; }
- ISendEmailNodeDescriptor Descriptor { get; }
- IMobileEmail Email { get; set; }
- IExpression From { get; }
- bool LogContent { get; set; }
- string Name { get; set; }
- IActionNode Target { get; set; }
- IExpression To { get; }
- void SetAttachments(ExpressionDefinition value)
- void SetBcc(ExpressionDefinition value)
- void SetCc(ExpressionDefinition value)
- void SetFrom(ExpressionDefinition value)
- void SetTo(ExpressionDefinition value)

### interface ISendEmailNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IExpressionProperty AttachmentsProperty { get; }
- IExpressionProperty BccProperty { get; }
- IExpressionProperty CcProperty { get; }
- IProperty EmailProperty { get; }
- IExpressionProperty FromProperty { get; }
- IProperty LogContentProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }
- IExpressionProperty ToProperty { get; }

## OutSystems.Model.Logic.Nodes

### interface IActionNode : IFlowNode
- IEnumerable<IActionConnector> Connectors { get; }
- IActionNodeDescriptor Descriptor { get; }
- IEnumerable<IActionConnector> IncomingConnectors { get; }

### interface IActionNodeDescriptor : IFlowNodeDescriptor

### interface IAggregateNode : IActionNode, IAggregate
- IAggregateNodeDescriptor Descriptor { get; }
- IActionNode Target { get; set; }
- IEnumerable<string> TextResourcesIds { get; }

### interface IAggregateNodeDescriptor : IActionNodeDescriptor, IAggregateDescriptor
- IProperty TargetProperty { get; }

### interface IAjaxRefreshNode : IActionNode
- AjaxRefreshAnimationEffectType AnimationEffect { get; set; }
- IAjaxRefreshNodeDescriptor Descriptor { get; }
- IExpression RowNumber { get; }
- IActionNode Target { get; set; }
- IObject WidgetOrWebBlock { get; set; }
- void SetRowNumber(ExpressionDefinition value)

### interface IAjaxRefreshNodeDescriptor : IActionNodeDescriptor
- IProperty AnimationEffectProperty { get; }
- IExpressionProperty RowNumberProperty { get; }
- IProperty TargetProperty { get; }
- IProperty WidgetOrWebBlockProperty { get; }

### interface IAssignNode : IActionNode
- ISequence<IAssignment> Assignments { get; }
- IAssignNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IActionNode Target { get; set; }
- IAssignment CreateAssignment()

### interface IAssignNodeDescriptor : IActionNodeDescriptor
- IChildCollection AssignmentsChildCollection { get; }
- IProperty LabelProperty { get; }
- IProperty TargetProperty { get; }

### interface IAttachFileNode : IActionNode
- IAttachFileNodeDescriptor Descriptor { get; }
- IExpression FileContent { get; }
- IExpression FileName { get; }
- IExpression MimeType { get; }
- string Name { get; set; }
- IActionNode Target { get; set; }
- void SetFileContent(ExpressionDefinition value)
- void SetFileName(ExpressionDefinition value)
- void SetMimeType(ExpressionDefinition value)

### interface IAttachFileNodeDescriptor : IActionNodeDescriptor
- IExpressionProperty FileContentProperty { get; }
- IExpressionProperty FileNameProperty { get; }
- IExpressionProperty MimeTypeProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface ICallAgentCoreNode : IActionNode
- ISequence<IActionHandler> ActionHandlers { get; }
- IServerActionSignature AIModel { get; set; }
- IExpression CallCondition { get; }
- string Description { get; set; }
- ICallAgentCoreNodeDescriptor Descriptor { get; }
- bool EnableActionCalling { get; set; }
- IExpression ExtraBody { get; }
- IExpression MaxTokens { get; }
- IExpression Messages { get; }
- string Name { get; set; }
- IStructureSignature OutputFormat { get; set; }
- string OutputFormatDescription { get; set; }
- IExpression Stop { get; }
- IActionNode Target { get; set; }
- IExpression Temperature { get; }
- IActionHandler CreateActionHandler(IKey key = null)
- string GetOutputFormatAttributeDescription(IAttributeSignature attribute)
- void SetCallCondition(ExpressionDefinition value)
- void SetExtraBody(ExpressionDefinition value)
- void SetMaxTokens(ExpressionDefinition value)
- void SetMessages(ExpressionDefinition value)
- void SetOutputFormatAttributeDescription(IAttributeSignature attribute, string description)
- void SetStop(ExpressionDefinition value)
- void SetTemperature(ExpressionDefinition value)

### interface ICallAgentCoreNodeDescriptor : IActionNodeDescriptor
- IChildCollection ActionHandlersChildCollection { get; }
- IProperty AIModelProperty { get; }
- IExpressionProperty CallConditionProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EnableActionCallingProperty { get; }
- IExpressionProperty ExtraBodyProperty { get; }
- IExpressionProperty MaxTokensProperty { get; }
- IExpressionProperty MessagesProperty { get; }
- IProperty NameProperty { get; }
- IProperty OutputFormatDescriptionProperty { get; }
- IProperty OutputFormatProperty { get; }
- IExpressionProperty StopProperty { get; }
- IProperty TargetProperty { get; }
- IExpressionProperty TemperatureProperty { get; }

### interface ICallAgentManifestNode : IActionNode
- IAgentManifestSignature Agent { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- AgentManifestCallType CallType { get; set; }
- string Description { get; set; }
- ICallAgentManifestNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- bool ReturnImmediately { get; set; }
- IActionNode Target { get; set; }
- IExpression TimeoutSeconds { get; }
- void SetTimeoutSeconds(ExpressionDefinition value)

### interface ICallAgentManifestNodeDescriptor : IActionNodeDescriptor
- IProperty AgentProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty CallTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }
- IProperty ReturnImmediatelyProperty { get; }
- IProperty TargetProperty { get; }
- IExpressionProperty TimeoutSecondsProperty { get; }

### interface ICallAgentNode : IActionNode
- IAgent Agent { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- string Description { get; set; }
- ICallAgentNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- IActionNode Target { get; set; }

### interface ICallAgentNodeDescriptor : IActionNodeDescriptor
- IProperty AgentProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface ICommentConnector : IActionConnector
- ICommentConnectorDescriptor Descriptor { get; }
- string Label { get; set; }

### interface ICommentConnectorDescriptor : IActionConnectorDescriptor
- IProperty LabelProperty { get; }

### interface ICommentNode : IActionNode
- IEnumerable<ICommentConnector> Connectors { get; }
- string CreatedBy { get; set; }
- ICommentNodeDescriptor Descriptor { get; }
- bool IsReminder { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Text { get; set; }
- ICommentConnector CreateConnector(IActionNode target)

### interface ICommentNodeDescriptor : IActionNodeDescriptor
- IChildCollection ConnectorsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty IsReminderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty TextProperty { get; }

### interface IDecisionOutcomeNode : IActionNode
- IDecisionConnector Connector { get; set; }
- IDecisionOutcomeNodeDescriptor Descriptor { get; }

### interface IDecisionOutcomeNodeDescriptor : IActionNodeDescriptor
- IProperty ConnectorProperty { get; }

### interface IDestinationNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- IDestinationNodeDescriptor Descriptor { get; }
- IObjectSignature Destination { get; set; }
- TransitionTypeWithInheritance Transition { get; set; }

### interface IDestinationNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DestinationProperty { get; }
- IProperty TransitionProperty { get; }

### interface IDownloadNode : IActionNode
- IDownloadNodeDescriptor Descriptor { get; }
- IExpression FileContent { get; }
- IExpression FileName { get; }
- IExpression MimeType { get; }
- bool SaveToDisk { get; set; }
- void SetFileContent(ExpressionDefinition value)
- void SetFileName(ExpressionDefinition value)
- void SetMimeType(string value)
- void SetMimeType(ExpressionDefinition value)

### interface IDownloadNodeDescriptor : IActionNodeDescriptor
- IExpressionProperty FileContentProperty { get; }
- IExpressionProperty FileNameProperty { get; }
- IExpressionProperty MimeTypeProperty { get; }
- IProperty SaveToDiskProperty { get; }

### interface IEndNode : IActionNode
- IEndNodeDescriptor Descriptor { get; }

### interface IEndNodeDescriptor : IActionNodeDescriptor

### interface IExcelToRecordListNode : IActionNode
- IListType DataType { get; set; }
- string Description { get; set; }
- IExcelToRecordListNodeDescriptor Descriptor { get; }
- IExpression FileContent { get; }
- string Name { get; set; }
- IExpression SheetName { get; }
- IActionNode Target { get; set; }
- void SetFileContent(ExpressionDefinition value)
- void SetSheetName(ExpressionDefinition value)

### interface IExcelToRecordListNodeDescriptor : IActionNodeDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DescriptionProperty { get; }
- IExpressionProperty FileContentProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SheetNameProperty { get; }
- IProperty TargetProperty { get; }

### interface IExceptionHandlerNode : IActionNode
- bool AbortTransaction { get; set; }
- IExceptionHandlerNodeDescriptor Descriptor { get; }
- IException Exception { get; set; }
- bool LogError { get; set; }
- string Name { get; set; }
- IActionNode Target { get; set; }

### interface IExceptionHandlerNodeDescriptor : IActionNodeDescriptor
- IProperty AbortTransactionProperty { get; }
- IProperty ExceptionProperty { get; }
- IProperty LogErrorProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface IExecuteClientActionNode : IActionNode
- IActionSignature Action { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- IExecuteClientActionNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- IActionNode Target { get; set; }

### interface IExecuteClientActionNodeDescriptor : IActionNodeDescriptor
- IProperty ActionProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface IExecuteServerActionNode : IActionNode
- IActionSignature Action { get; set; }
- ExecuteActionAnimationEffectType AnimationEffect { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- IExecuteServerActionNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- int? ServerRequestTimeout { get; set; }
- IActionNode Target { get; set; }

### interface IExecuteServerActionNodeDescriptor : IActionNodeDescriptor
- IProperty ActionProperty { get; }
- IProperty AnimationEffectProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty ServerRequestTimeoutProperty { get; }
- IProperty TargetProperty { get; }

### interface IForEachNode : IActionNode
- IActionNode CycleTarget { get; set; }
- IForEachNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IExpression MaximumIterations { get; }
- IEnumerable<IActionNode> NodesWithinCycle { get; }
- IExpression RecordList { get; }
- IExpression StartIndex { get; }
- IActionNode Target { get; set; }
- void SetMaximumIterations(ExpressionDefinition value)
- void SetRecordList(ExpressionDefinition value)
- void SetStartIndex(ExpressionDefinition value)
- void SwapConnectors()

### interface IForEachNodeDescriptor : IActionNodeDescriptor
- IProperty CycleTargetProperty { get; }
- IProperty LabelProperty { get; }
- IExpressionProperty MaximumIterationsProperty { get; }
- IExpressionProperty RecordListProperty { get; }
- IExpressionProperty StartIndexProperty { get; }
- IProperty TargetProperty { get; }

### interface IIfNode : IActionNode
- IExpression Condition { get; }
- IIfNodeDescriptor Descriptor { get; }
- IActionNode FalseTarget { get; set; }
- string Label { get; set; }
- IActionNode TrueTarget { get; set; }
- void SetCondition(ExpressionDefinition value)
- void SwapConnectors()

### interface IIfNodeDescriptor : IActionNodeDescriptor
- IExpressionProperty ConditionProperty { get; }
- IProperty FalseTargetProperty { get; }
- IProperty LabelProperty { get; }
- IProperty TrueTargetProperty { get; }

### interface IJavaScriptNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- IJavaScriptNodeDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- bool IsAsynchronous { get; }
- string JavaScript { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Name { get; set; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IActionNode Target { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)

### interface IJavaScriptNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty IsAsynchronousProperty { get; }
- IProperty JavaScriptProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IProperty TargetProperty { get; }

### interface IJSONDeserializeNode : IActionNode
- ITypeSignature DataType { get; set; }
- JSONDateFormat DateFormat { get; set; }
- string Description { get; set; }
- IJSONDeserializeNodeDescriptor Descriptor { get; }
- IExpression JSONString { get; }
- string Name { get; set; }
- IActionNode Target { get; set; }
- void SetJSONString(ExpressionDefinition value)

### interface IJSONDeserializeNodeDescriptor : IActionNodeDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DateFormatProperty { get; }
- IProperty DescriptionProperty { get; }
- IExpressionProperty JSONStringProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface IJSONSerializeNode : IActionNode
- IExpression Data { get; }
- JSONDateFormat DateFormat { get; set; }
- string Description { get; set; }
- IJSONSerializeNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- bool SerializeDefaultValues { get; set; }
- IActionNode Target { get; set; }
- void SetData(ExpressionDefinition value)

### interface IJSONSerializeNodeDescriptor : IActionNodeDescriptor
- IExpressionProperty DataProperty { get; }
- IProperty DateFormatProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }
- IProperty SerializeDefaultValuesProperty { get; }
- IProperty TargetProperty { get; }

### interface IMessageNode : IActionNode
- IMessageNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IExpression Message { get; }
- IActionNode Target { get; set; }
- MessageType Type { get; set; }
- void SetMessage(ExpressionDefinition value)

### interface IMessageNodeDescriptor : IActionNodeDescriptor
- IProperty LabelProperty { get; }
- IExpressionProperty MessageProperty { get; }
- IProperty TargetProperty { get; }
- IProperty TypeProperty { get; }

### interface IRaiseExceptionNode : IActionNode
- IRaiseExceptionNodeDescriptor Descriptor { get; }
- IException Exception { get; set; }
- IExpression ExceptionMessage { get; }
- void SetExceptionMessage(ExpressionDefinition value)

### interface IRaiseExceptionNodeDescriptor : IActionNodeDescriptor
- IExpressionProperty ExceptionMessageProperty { get; }
- IProperty ExceptionProperty { get; }

### interface IRecordListToExcelAttribute
- IAttributeSignature Attribute { get; }
- IAttributeSignature AttributeParent { get; }

### interface IRecordListToExcelNode : IActionNode
- IEnumerable<string> AttributeSelection { get; }
- IEnumerable<IRecordListToExcelAttribute> AttributeSelectionDetails { get; }
- string Description { get; set; }
- IRecordListToExcelNodeDescriptor Descriptor { get; }
- string Name { get; set; }
- IExpression RecordList { get; }
- IActionNode Target { get; set; }
- void AddAttributeSelection(string attribute)
- void AddAttributeSelection(IAttributeSignature attribute)
- void AddAttributeSelection(IAttributeSignature attributeParent, IAttributeSignature attribute)
- void RemoveAttributeSelection(string attribute)
- void RemoveAttributeSelection(IAttributeSignature attribute)
- void RemoveAttributeSelection(IAttributeSignature attributeParent, IAttributeSignature attribute)
- void SetRecordList(ExpressionDefinition value)

### interface IRecordListToExcelNodeDescriptor : IActionNodeDescriptor
- IProperty AttributeSelectionProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty RecordListProperty { get; }
- IProperty TargetProperty { get; }

### interface IRefreshDataNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- IObject DataSource { get; set; }
- IRefreshDataNodeDescriptor Descriptor { get; }
- IExpression MaxRecords { get; }
- IExpression StartIndex { get; }
- IActionNode Target { get; set; }
- void SetMaxRecords(ExpressionDefinition value)
- void SetStartIndex(ExpressionDefinition value)

### interface IRefreshDataNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DataSourceProperty { get; }
- IExpressionProperty MaxRecordsProperty { get; }
- IExpressionProperty StartIndexProperty { get; }
- IProperty TargetProperty { get; }

### interface ISemanticSearchNode : IActionNode
- string Description { get; set; }
- ISemanticSearchNodeDescriptor Descriptor { get; }
- IExpression Filters { get; }
- IExpression MinimumScore { get; }
- string Name { get; set; }
- IExpression PageNumber { get; }
- IExpression PageSize { get; }
- ITypeSignature ResultListType { get; }
- IEnumerable<ISearchableAttributeSignature> SearchAttributes { get; }
- IExpression SearchQuery { get; }
- IRecordTypeSignature Source { get; set; }
- IActionNode Target { get; set; }
- int? Timeout { get; set; }
- void AddSearchableAttributes(ISearchableAttributeSignature[] attributes)
- void RemoveSearchableAttributes(ISearchableAttributeSignature[] attributes)
- void SetFilters(ExpressionDefinition value)
- void SetMinimumScore(ExpressionDefinition value)
- void SetPageNumber(ExpressionDefinition value)
- void SetPageSize(ExpressionDefinition value)
- void SetSearchQuery(ExpressionDefinition value)

### interface ISemanticSearchNodeDescriptor : IActionNodeDescriptor
- IProperty DescriptionProperty { get; }
- IExpressionProperty FiltersProperty { get; }
- IExpressionProperty MinimumScoreProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty PageNumberProperty { get; }
- IExpressionProperty PageSizeProperty { get; }
- IProperty ResultListTypeProperty { get; }
- IExpressionProperty SearchQueryProperty { get; }
- IProperty SourceProperty { get; }
- IProperty TargetProperty { get; }
- IProperty TimeoutProperty { get; }

### interface ISendEmailNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- IExpression Bcc { get; }
- IExpression Cc { get; }
- ISendEmailNodeDescriptor Descriptor { get; }
- IWebEmail Email { get; set; }
- IExpression From { get; }
- bool LogContent { get; set; }
- string Name { get; set; }
- IActionNode Target { get; set; }
- IExpression To { get; }
- void SetBcc(ExpressionDefinition value)
- void SetCc(ExpressionDefinition value)
- void SetFrom(ExpressionDefinition value)
- void SetTo(ExpressionDefinition value)

### interface ISendEmailNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IExpressionProperty BccProperty { get; }
- IExpressionProperty CcProperty { get; }
- IProperty EmailProperty { get; }
- IExpressionProperty FromProperty { get; }
- IProperty LogContentProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }
- IExpressionProperty ToProperty { get; }

### interface ISQLNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- int? CacheInMinutes { get; set; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- ISQLNodeDescriptor Descriptor { get; }
- ISequence<ISQLInputParameter> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IExpression MaxRecords { get; }
- string Name { get; set; }
- ISequence<ISQLOutput> Outputs { get; }
- string Statement { get; set; }
- IActionNode Target { get; set; }
- int? Timeout { get; set; }
- IListType Type { get; }
- ISQLInputParameter CreateInputParameter(string name = null, IKey key = null)
- ISQLOutput CreateOutput(IRecordTypeSignature entityOrStructure, string name = null)
- void SetMaxRecords(ExpressionDefinition value)

### interface ISQLNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty CacheInMinutesProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IExpressionProperty MaxRecordsProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputsChildCollection { get; }
- IProperty StatementProperty { get; }
- IProperty TargetProperty { get; }
- IProperty TimeoutProperty { get; }
- IProperty TypeProperty { get; }

### interface IStartNode : IActionNode
- IStartNodeDescriptor Descriptor { get; }
- IActionNode Target { get; set; }

### interface IStartNodeDescriptor : IActionNodeDescriptor
- IProperty TargetProperty { get; }

### interface ISwitchCondition : IActionConnector
- ISwitchConditionDescriptor Descriptor { get; }
- string Label { get; set; }
- IExpression Value { get; }
- void SetValue(ExpressionDefinition value)

### interface ISwitchConditionDescriptor : IActionConnectorDescriptor
- IProperty LabelProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface ISwitchNode : IActionNode
- ISequence<ISwitchCondition> Conditions { get; }
- ISwitchNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IActionNode OtherwiseTarget { get; set; }
- ISwitchCondition CreateCondition()

### interface ISwitchNodeDescriptor : IActionNodeDescriptor
- IChildCollection ConditionsChildCollection { get; }
- IProperty LabelProperty { get; }
- IProperty OtherwiseTargetProperty { get; }

### interface ITriggerGlobalNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- ITriggerGlobalNodeDescriptor Descriptor { get; }
- IGlobalEvent Event { get; set; }
- string Name { get; set; }
- IActionNode Target { get; set; }

### interface ITriggerGlobalNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty EventProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface ITriggerNode : IActionNode
- IEnumerable<IArgument> Arguments { get; }
- string Description { get; set; }
- ITriggerNodeDescriptor Descriptor { get; }
- ITriggerableEvent Event { get; set; }
- string Name { get; set; }
- IActionNode Target { get; set; }

### interface ITriggerNodeDescriptor : IActionNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty EventProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

## OutSystems.Model.Merge

### enum DifferenceType
- None
- NotInitialized
- Different
- DifferenceInChildren
- AddedToLocal
- AddedToForeign
- RemovedFromLocal
- RemovedFromForeign
- ChangedInLocal
- ChangedInForeign
- Conflict
- DifferenceInLocalChildren
- DifferenceInForeignChildren
- DifferenceInLocalMergeUnit
- DifferenceInForeignMergeUnit
- ConflictInMergeUnit
- MergeableDifference

### interface IMatch
- IObjectSignature Base { get; }
- IEnumerable<IMatch> Children { get; }
- DifferenceType Difference { get; }
- DifferenceType DifferenceIncludingNonVisibleProperties { get; }
- IObjectSignature Foreign { get; }
- IObjectSignature Local { get; }
- MergeAction MergeAction { get; set; }
- IMatch MergeUnit { get; }
- IEnumerable<IPropertyPair> Properties { get; }
- MatchType Type { get; }

### interface IMatchTree : IDisposable
- IEnumerable<IMatch> AllMatches { get; }
- IEnumerable<IMatch> Roots { get; }
- string Dump()
- IEnumerable<IMatch> GetMatches(Func<IMatch, bool> predicate)
- void Merge()

### interface IPropertyPair
- object BaseValue { get; }
- DifferenceType Difference { get; }
- object ForeignValue { get; }
- bool IsVisible { get; }
- object LocalValue { get; }
- MergeAction MergeAction { get; set; }
- string PropertyName { get; }

### enum MatchType
- InBothESpaces
- InLocalESpaceOnly
- InForeignESpaceOnly
- InBaseESpaceOnly

### enum MergeAction
- None
- Create
- Update
- Delete
- Merge
- Unknown

## OutSystems.Model.MetaModel

### class BehaviorInterfaceAttribute : Attribute

### class ChildAttribute : Attribute

### class ChildCollection : IChildCollection
- string AlternativeName { get; }
- Type ElementType { get; }
- bool IsAutoCreated { get; }
- bool IsAutoCreatedWithManualImplementation { get; }
- bool IsSequence { get; }
- bool IsSingleton { get; }
- string Name { get; }
- string ToString()

### class ChildCollection<TObject, TElement> : ChildCollection, IChildCollection, IChildCollection<TObject, TElement>
- Type ElementType { get; }
- Func<TObject, IEnumerable<TElement>> GetValue { get; }
- Func<TObject, bool> IsLoaded { get; }

### class ChildrenAttribute : Attribute

### class ClassDescriptor : IClassDescriptor, IDiscoverable
- IEnumerable<IClassDescriptor> AllDescriptors { get; }
- IEnumerable<IChildCollection> ChildCollections { get; }
- IEnumerable<IProperty> Properties { get; }
- IClassDescriptor GetDescriptor(IModelObject obj)
- IEnumerable<IClassDescriptor> GetDescriptorsFor<T>()
- IEnumerable<IClassDescriptor> GetDescriptorsFor(Type type)
- IKey GetSingletonCollectionLocalKey(IKey parentKey, string collectionName)
- bool MatchesType(IModelObject obj, Type type)
- IEnumerable<T> OfType<T>()
- T Single<T>()

### class ClassDescriptor<TClass, TInterface> : ClassDescriptor, IClassDescriptor, IDiscoverable

### class EnumValueAttribute : Attribute
- string DisplayName { get; set; }

### class ExpressionChildCollection : IChildCollection
- string AlternativeName { get; }
- Type ElementType { get; }
- Func<IModelObject, IEnumerable<IModelObject>> GetValue { get; }
- bool IsAutoCreated { get; }
- bool IsAutoCreatedWithManualImplementation { get; }
- Func<IModelObject, bool> IsLoaded { get; }
- bool IsSequence { get; }
- bool IsSingleton { get; }
- string Name { get; }
- bool Equals(object obj)
- int GetHashCode()

### class ExpressionProperty<ObjType> : Property<ObjType>, IExpressionProperty, IProperty
- PropertyKind Kind { get; }
- TypeKind RuntimeTypeKind { get; }
- bool SupportsRecordAndListLiterals { get; }
- bool SupportsTypeConversion { get; }
- Type Type { get; }
- IEnumerable<ITypeSignature> GetRequiredTypes(IModelObject obj)
- IExpression GetValue(ObjType obj)
- object GetValue(IModelObject obj)
- void SetValue(ObjType obj, ExpressionDefinition value)
- void SetValue(IModelObject obj, ExpressionDefinition value)
- void SetValue(IModelObject obj, object value)

### class ExpressionPropertyAttribute : PropertyAttribute
- TypeKind RuntimeTypeKind { get; set; }
- bool SupportsRecordAndListLiterals { get; set; }
- bool SupportsTypeConversion { get; set; }

### interface IChildCollection
- string AlternativeName { get; }
- Type ElementType { get; }
- Func<IModelObject, IEnumerable<IModelObject>> GetValue { get; }
- bool IsAutoCreated { get; }
- bool IsAutoCreatedWithManualImplementation { get; }
- Func<IModelObject, bool> IsLoaded { get; }
- bool IsSequence { get; }
- bool IsSingleton { get; }
- string Name { get; }

### interface IChildCollection<TObject, TElement> : IChildCollection
- Func<TObject, IEnumerable<TElement>> GetValue { get; }

### interface IClassDescriptor
- IEnumerable<IChildCollection> ChildCollections { get; }
- IEnumerable<IProperty> Properties { get; }
- IKey GetSingletonCollectionLocalKey(IKey parentKey, string collectionName)

### interface IExpressionProperty : IProperty
- TypeKind RuntimeTypeKind { get; }
- bool SupportsRecordAndListLiterals { get; }
- bool SupportsTypeConversion { get; }
- IEnumerable<ITypeSignature> GetRequiredTypes(IModelObject obj)
- void SetValue(IModelObject obj, ExpressionDefinition value)

### interface ILambdaExpressionProperty : IExpressionProperty

### interface IPreviousValue
- string PreviousName { get; }
- string PreviousNameUsedInReference { get; }

### interface IProperty
- string Description { get; }
- string DisplayName { get; }
- string Group { get; }
- PropertyKind Kind { get; }
- string Name { get; }
- Type Type { get; }
- object GetDefaultValue(IModelObject obj)
- string GetDescription(IModelObject obj)
- IPreviousValue GetPreviousValue(IModelObject obj)
- object GetValue(IModelObject obj)
- bool IsReadOnly(IModelObject obj)
- bool IsVisible(IModelObject obj)
- void SetValue(IModelObject obj, object value)

### interface IUnderlyingModelProperty : IProperty
- IProperty Property { get; }

### interface IVariableProperty : IExpressionProperty

### static class MetamodelExtensions
- IChildCollection GetChildCollection(IClassDescriptor descriptor, string name)
- IProperty GetProperty(IClassDescriptor descriptor, string name)

### class ModelInterfaceAttribute : Attribute
- Type[] BehaviorInterfaces { get; set; }
- string Description { get; set; }
- string DisplayName { get; set; }
- string Icon { get; set; }
- bool IsConcrete { get; set; }

### class Property : IProperty
- string Description { get; }
- string DisplayName { get; }
- string Group { get; }
- PropertyKind Kind { get; }
- string Name { get; }
- Type Type { get; }
- object GetDefaultValue(IModelObject obj)
- string GetDescription(IModelObject obj)
- IPreviousValue GetPreviousValue(IModelObject obj)
- object GetValue(IModelObject obj)
- bool IsReadOnly(IModelObject obj)
- bool IsVisible(IModelObject obj)
- void SetValue(IModelObject obj, object value)
- string ToString()

### class Property<ObjType> : Property, IProperty
- bool IsReadOnly(IModelObject obj)
- bool IsVisible(IModelObject obj)

### class Property<ObjType, PropType> : Property<ObjType>, IProperty
- Type Type { get; }
- PropType GetValue(ObjType obj)
- object GetValue(IModelObject obj)
- bool IsReadOnly(IModelObject obj)
- void SetValue(ObjType obj, PropType value)
- void SetValue(IModelObject obj, object value)

### class PropertyAttribute : Attribute
- string DisplayName { get; set; }
- bool? IsMandatory { get; set; }
- bool? IsVisible { get; set; }

### class UnderlyingModelExpressionProperty<TObject> : UnderlyingModelProperty, IExpressionProperty, IProperty, IUnderlyingModelProperty
- IExpressionProperty Property { get; }
- TypeKind RuntimeTypeKind { get; }
- bool SupportsRecordAndListLiterals { get; }
- bool SupportsTypeConversion { get; }
- Type Type { get; }
- IEnumerable<ITypeSignature> GetRequiredTypes(IModelObject obj)
- object GetValue(IModelObject obj)
- void SetValue(IModelObject obj, object value)
- void SetValue(IModelObject obj, ExpressionDefinition value)

### class UnderlyingModelLambdaExpressionProperty<TObject> : UnderlyingModelExpressionProperty<TObject>, IExpressionProperty, ILambdaExpressionProperty, IProperty, IUnderlyingModelProperty

### class UnderlyingModelProperty : IProperty, IUnderlyingModelProperty
- string Description { get; }
- string DisplayName { get; }
- string Group { get; }
- PropertyKind Kind { get; }
- string Name { get; }
- IProperty Property { get; }
- Type Type { get; }
- object GetDefaultValue(IModelObject obj)
- string GetDescription(IModelObject obj)
- IPreviousValue GetPreviousValue(IModelObject obj)
- object GetValue(IModelObject obj)
- bool IsReadOnly(IModelObject obj)
- bool IsVisible(IModelObject obj)
- void SetValue(IModelObject obj, object value)
- string ToString()

### class UnderlyingModelProperty<TObject, TProperty> : UnderlyingModelProperty, IProperty, IUnderlyingModelProperty
- Type Type { get; }
- object GetValue(IModelObject obj)
- bool IsReadOnly(IModelObject obj)
- void SetValue(IModelObject obj, object value)

### class UnderlyingModelVariableProperty<TObject> : UnderlyingModelExpressionProperty<TObject>, IExpressionProperty, IProperty, IUnderlyingModelProperty, IVariableProperty

## OutSystems.Model.ModelFeatures

### interface IModelFeaturesManager
- void AddUsage(ModelFeature modelFeature, IExtension extension, string propertyName)
- void AddUsage(ModelFeature modelFeature, IExtensionObject extensionObject, string propertyName)
- IEnumerable<ModelFeature> GetAllModelFeaturesUsages()
- IEnumerable<IModelFeatureUsage> GetModelFeaturesUsages(IExtension extension)
- IEnumerable<IModelFeatureUsage> GetModelFeaturesUsages(IExtensionObject extensionObject)
- IEnumerable<IModelFeatureUsage> GetUsages(ModelFeature feature)
- void RemoveAllModelFeaturesUsages()
- void RemoveUsage(ModelFeature modelFeature, IExtension extension, string propertyName)
- void RemoveUsage(ModelFeature modelFeature, IExtensionObject extensionObject, string propertyName)

### interface IModelFeatureUsage
- ModelFeature Feature { get; }
- ICompoundKey ObjectCompoundKey { get; }
- string PropertyName { get; }

### interface IPlatformCapabilities
- ModelFeatureStatus GetModelFeatureSupport(ModelFeature feature)
- bool IsEntitlementAvailable(string entitlement)

### class ModelFeature : IEquatable<ModelFeature>
- bool CheckEnvironmentCompatibility { get; }
- ModelFeatureStatus? DefaultO11CompilerStatus { get; set; }
- ModelFeatureStatus? DefaultODCCompilerStatus { get; set; }
- string Id { get; }
- bool IsExcludedFromCompiler { get; }
- bool IsUsedByExtensionsOnly { get; }
- string Name { get; }
- bool PredatesContinuousDelivery { get; }
- ModelFeatureStatus Status { get; set; }
- Guid Uuid { get; }
- bool Equals(object obj)
- bool Equals(ModelFeature other)
- int GetHashCode()
- ModelFeature Parse(string str, bool predatesContinuousDelivery, Func<string, IEnumerable<string>> listDecoder)
- string SerializeToString(Func<IEnumerable<string>, string> listEncoder)
- string ToString()

### static class ModelFeatures

### enum ModelFeatureStatus
- Undefined
- Removed
- InDevelopment
- EarlyAccess
- Preview
- Stable

### static class ModelFeatureStatusExtensions
- bool IsMoreStableThan(ModelFeatureStatus status, ModelFeatureStatus other)

### static class PlatformCapabilities
- IPlatformCapabilities AllSupported { get; }
- IPlatformCapabilities Create(Func<ModelFeature, ModelFeatureStatus> modelFeatureSupport, Func<string, bool> entitlementSupport)

## OutSystems.Model.ModelPlugins

### interface IModelPlugin : IModule
- string AssemblyName { get; set; }
- Version AssemblyVersion { get; set; }
- IModelPluginDescriptor Descriptor { get; }
- ExtensionKind ExtensionKind { get; }
- Byte[] Icon { get; set; }
- IModelFeaturesManager ModelFeaturesManager { get; }
- string ReactBundleName { get; set; }
- string ReactModuleName { get; set; }
- IEnumerable<IExtensionResource> Resources { get; }
- Byte[] SignatureBinary { get; }
- Guid SignatureHash { get; }
- string StylesheetModuleName { get; set; }
- IEnumerable<ITheme> Themes { get; }
- IEnumerable<IWidgetDefinition> WidgetDefinitions { get; }
- IExtensionResource CreateResource(string filename, Byte[] content, IKey key = null)
- ITheme CreateTheme(string name = null, IKey key = null)
- IWidgetDefinition CreateWidgetDefinition(string name = null, IKey key = null)

### interface IModelPluginDescriptor : IModuleDescriptor
- IProperty AssemblyNameProperty { get; }
- IProperty AssemblyVersionProperty { get; }
- IProperty IconProperty { get; }
- IProperty ReactBundleNameProperty { get; }
- IProperty ReactModuleNameProperty { get; }
- IChildCollection<IModelPlugin, IExtensionResource> ResourcesChildCollection { get; }
- IProperty StylesheetModuleNameProperty { get; }
- IChildCollection<IModelPlugin, ITheme> ThemesChildCollection { get; }
- IChildCollection<IModelPlugin, IWidgetDefinition> WidgetDefinitionsChildCollection { get; }

### interface IModelPluginObject : IModelObject
- IModelPlugin GetPlugin()

### interface IModelPluginUpdateInformation
- string DeveloperId { get; set; }
- string NewReferenceRevision { get; set; }
- string NewReferenceVersion { get; set; }
- string NewSpecificVersionHash { get; set; }
- Version NewVersion { get; }

### interface IRequiredModelPlugin : IObject
- string AssemblyName { get; }
- Version AssemblyVersion { get; }
- IRequiredModelPluginDescriptor Descriptor { get; }
- IKey PluginKey { get; }
- Guid SpecificVersionHash { get; }
- Guid UniqueId { get; }

### interface IRequiredModelPluginDescriptor : IObjectDescriptor
- IProperty AssemblyNameProperty { get; }
- IProperty AssemblyVersionProperty { get; }
- IProperty PluginKeyProperty { get; }
- IProperty SpecificVersionHashProperty { get; }
- IProperty UniqueIdProperty { get; }

### interface IShareableModelPluginObject : IModelPluginObject, IShareable

### interface IShareableModelPluginObject<ConcreteT, SignatureT> : IShareableModelPluginObject

### interface IWidgetDefinition : IShareableModelPluginObject<IWidgetDefinition, IWidgetDefinitionSignature>
- string Description { get; set; }
- IWidgetDefinitionDescriptor Descriptor { get; }
- bool HasValidationProperties { get; set; }
- bool IsValidationAggregator { get; set; }
- string Name { get; set; }
- IEnumerable<IWidgetDefinitionPlaceholder> Placeholders { get; }
- ISequence<IWidgetDefinitionProperty> Properties { get; }
- IEnumerable<IWidgetDefinitionRequiredResource> RequiredResources { get; }
- IWidgetDefinitionPlaceholder CreatePlaceholder(string name = null, IKey key = null)
- IWidgetDefinitionProperty CreateProperty(string name = null, IKey key = null)
- IWidgetDefinitionRequiredResource CreateRequiredResource(IKey key, IExtensionResource resource)

### interface IWidgetDefinitionDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty HasValidationPropertiesProperty { get; }
- IProperty IsValidationAggregatorProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection<IWidgetDefinition, IWidgetDefinitionPlaceholder> PlaceholdersChildCollection { get; }
- IChildCollection<IWidgetDefinition, IWidgetDefinitionProperty> PropertiesChildCollection { get; }
- IChildCollection<IWidgetDefinition, IWidgetDefinitionRequiredResource> RequiredResourcesChildCollection { get; }

### interface IWidgetDefinitionPlaceholder : IModelPluginObject
- string Description { get; set; }
- IWidgetDefinitionPlaceholderDescriptor Descriptor { get; }
- bool IsIterated { get; set; }
- string Name { get; set; }
- string SourceProperty { get; set; }

### interface IWidgetDefinitionPlaceholderDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IsIteratedProperty { get; }
- IProperty NameProperty { get; }
- IProperty SourcePropertyProperty { get; }

### interface IWidgetDefinitionProperty : IModelPluginObject
- string DefaultValue { get; set; }
- string Description { get; set; }
- IWidgetDefinitionPropertyDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }
- string LambdaExpressionSourceProperty { get; set; }
- LambdaExpressionTarget LambdaExpressionTarget { get; set; }
- string Name { get; set; }
- ModelPropertyKind PropertyKind { get; set; }
- PropertyRuntimeType RuntimeType { get; set; }

### interface IWidgetDefinitionPropertyDescriptor : IClassDescriptor
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LambdaExpressionSourcePropertyProperty { get; }
- IProperty LambdaExpressionTargetProperty { get; }
- IProperty NameProperty { get; }
- IProperty PropertyKindProperty { get; }
- IProperty RuntimeTypeProperty { get; }

### interface IWidgetDefinitionRequiredResource : IModelPluginObject
- string FileName { get; }
- IExtensionResource Resource { get; set; }

### class ModelPluginAttribute : Attribute
- string Description { get; set; }
- string IconResourceName { get; set; }
- bool IsBundledWithTheIDE { get; set; }
- string ReactBundleName { get; set; }
- string ReactModuleName { get; set; }
- string StylesheetModuleName { get; set; }

### class ModelPluginAwareDictionary<TKey, TValue>
- IEnumerable<TValue> Values { get; }
- void Add(TKey key, TValue value)
- TValue GetValue(TKey key, IEnumerable<IRequiredModelPlugin> allowedPlugins)
- TValue GetValue(TKey key, IEnumerable<ValueTuple<string, Version>> allowedPlugins)
- IEnumerable<TValue> GetValues(IEnumerable<IRequiredModelPlugin> allowedPlugins)
- IEnumerable<TValue> GetValues(IEnumerable<ValueTuple<string, Version>> allowedPlugins)
- IEnumerable<TValue> GetValues(string assemblyName, Version assemblyVersion)
- void Remove(TKey key)
- bool TryGetValue(TKey key, IEnumerable<IRequiredModelPlugin> allowedPlugins, out TValue value)
- bool TryGetValue(TKey key, IEnumerable<ValueTuple<string, Version>> allowedPlugins, out TValue value)

### class ModelPluginInformation
- string AssemblyName { get; }
- Version AssemblyVersion { get; }
- IKey PluginKey { get; }
- Guid SpecificVersionHash { get; }

### class ModelPluginUpdateInformation : IModelPluginUpdateInformation
- string DeveloperId { get; set; }
- string NewReferenceRevision { get; set; }
- string NewReferenceVersion { get; set; }
- string NewSpecificVersionHash { get; set; }
- Version NewVersion { get; }

### class ResolveModelPluginEventArgs : EventArgs
- ModelPluginInformation PluginInformation { get; }

### class ResolveModelPluginEventHandler : MulticastDelegate, ICloneable, ISerializable
- IAsyncResult BeginInvoke(object sender, ResolveModelPluginEventArgs args, AsyncCallback callback, object object)
- IModelPlugin EndInvoke(IAsyncResult result)
- IModelPlugin Invoke(object sender, ResolveModelPluginEventArgs args)

## OutSystems.Model.ModelPlugins.UI.Mobile

### interface ITheme : IShareableModelPluginObject<ITheme, IMobileThemeSignature>
- int Columns { get; set; }
- int ColumnWidth { get; set; }
- string Description { get; set; }
- IThemeDescriptor Descriptor { get; }
- GridType GridType { get; set; }
- int GutterWidth { get; set; }
- int GutterWidthPercentage { get; set; }
- string InvisibleStyleSheet { get; }
- int? MaxWidth { get; set; }
- int? MinWidth { get; set; }
- string Name { get; set; }
- string StyleSheet { get; set; }
- int TotalWidth { get; }

### interface IThemeDescriptor : IClassDescriptor
- IProperty ColumnsProperty { get; }
- IProperty ColumnWidthProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty GridTypeProperty { get; }
- IProperty GutterWidthPercentageProperty { get; }
- IProperty GutterWidthProperty { get; }
- IProperty InvisibleStyleSheetProperty { get; }
- IProperty MaxWidthProperty { get; }
- IProperty MinWidthProperty { get; }
- IProperty NameProperty { get; }
- IProperty StyleSheetProperty { get; }

### class ThemeAttribute : Attribute
- int Columns { get; set; }
- int ColumnWidth { get; set; }
- string Description { get; set; }
- GridType GridType { get; set; }
- int GutterWidth { get; set; }
- bool HasMaxWidth { get; set; }
- bool HasMinWidth { get; set; }
- int MaxWidth { get; set; }
- int MinWidth { get; set; }

## OutSystems.Model.Processes

### enum EntityActionKind
- None
- Create
- Update

### interface IActivityOutputParameter : IActivityOutputParameterSignature, IOutputParameter
- string CreatedBy { get; set; }
- IBasicType DataType { get; set; }
- IActivityOutputParameterDescriptor Descriptor { get; }
- ActivityInputType IsCloseActivityInput { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IActivityOutputParameterDescriptor : IActivityOutputParameterSignatureDescriptor, IOutputParameterDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IActivityOutputParameterSignature : IOutputParameterSignature
- IBasicType DataType { get; }
- IActivityOutputParameterSignatureDescriptor Descriptor { get; }
- ActivityInputType IsCloseActivityInput { get; }

### interface IActivityOutputParameterSignatureDescriptor : IOutputParameterSignatureDescriptor
- IProperty IsCloseActivityInputProperty { get; }

### interface IActivityTrigger : ITrigger
- IExpression IdFilter { get; }
- IExpression TenantIdFilter { get; }
- void SetIdFilter(string value)
- void SetTenantIdFilter(string value)

### interface IDayOfMonth : IScheduleItem
- ICollection<int> DayOfMonthValues { get; }
- IDayOfMonthDescriptor Descriptor { get; }

### interface IDayOfMonthDescriptor : IScheduleItemDescriptor
- IProperty DayOfMonthValuesProperty { get; }

### interface IDayOfWeek : IScheduleItem
- ICollection<int> DayOfWeekValues { get; }
- IDayOfWeekDescriptor Descriptor { get; }

### interface IDayOfWeekDescriptor : IScheduleItemDescriptor
- IProperty DayOfWeekValuesProperty { get; }

### interface IGlobalEvent : IGlobalEventSignature, IShareableESpaceObject<IGlobalEvent, IGlobalEventSignature>
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IGlobalEventDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IGlobalEventDescriptor : IGlobalEventSignatureDescriptor, IObjectDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IGlobalEventHandler : IObject
- IEnumerable<IArgument> Arguments { get; }
- IGlobalEventHandlerDescriptor Descriptor { get; }
- IGlobalEventSignature Event { get; }
- IServerAction Handler { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IGlobalEventHandlerDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty EventProperty { get; }
- IProperty HandlerProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IGlobalEventSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IGlobalEventSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- IEnumerable<IGlobalEventHandler> Handlers { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<string> TextResourcesIds { get; }
- IGlobalEventHandler CreateHandler(IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IGlobalEventSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IHour : IScheduleItem
- IHourDescriptor Descriptor { get; }
- ICollection<int> HourValues { get; }

### interface IHourDescriptor : IScheduleItemDescriptor
- IProperty HourValuesProperty { get; }

### interface IMinute : IScheduleItem
- IMinuteDescriptor Descriptor { get; }
- ICollection<int> MinuteValues { get; }

### interface IMinuteDescriptor : IScheduleItemDescriptor
- IProperty MinuteValuesProperty { get; }

### interface IMonth : IScheduleItem
- IMonthDescriptor Descriptor { get; }
- ICollection<int> MonthValues { get; }

### interface IMonthDescriptor : IScheduleItemDescriptor
- IProperty MonthValuesProperty { get; }

### interface IProcess : IFlow, IProcessSignature, IShareableESpaceObject<IProcess, IProcessSignature>
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IProcessDescriptor Descriptor { get; }
- IExpression Detail { get; }
- bool ExposeProcessEntity { get; set; }
- IFolder Folder { get; set; }
- Byte[] Icon { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string Label { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IProcessTrigger LaunchOn { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- IEnumerable<IProcessNode> Nodes { get; }
- ICallback OnActivityClose { get; }
- ICallback OnActivityOpen { get; }
- ICallback OnActivityReady { get; }
- ICallback OnActivitySkip { get; }
- ICallback OnActivityStart { get; }
- ICallback OnProcessStart { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IEnumerable<IRecordType> ProcessEntities { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IProcessNode CreateNode(Type type, string name = null, IKey key = null)
- ICallback CreateOnActivityClose()
- ICallback CreateOnActivityOpen()
- ICallback CreateOnActivityReady()
- ICallback CreateOnActivitySkip()
- ICallback CreateOnActivityStart()
- ICallback CreateOnProcessStart()
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- void SetDetail(ExpressionDefinition value)

### interface IProcessConnector : IConnector
- IProcessConnectorDescriptor Descriptor { get; }
- IProcessNode Source { get; }
- IProcessNode Target { get; set; }

### interface IProcessConnectorDescriptor : IConnectorDescriptor

### interface IProcessDescriptor : IFlowDescriptor, IProcessSignatureDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IExpressionProperty DetailProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection ProcessCallbacksChildCollection { get; }
- IChildCollection ProcessEntitiesChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IProcessSignature : IFlowSignature
- string CreatedBy { get; }
- string Description { get; }
- IProcessSignatureDescriptor Descriptor { get; }
- bool ExposeProcessEntity { get; }
- IFolderSignature Folder { get; }
- Byte[] Icon { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string Label { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- IActionSignature LaunchProcessAction { get; }
- IEnumerable<IOutputParameterSignature> OutputParameters { get; }

### interface IProcessSignatureDescriptor : IFlowSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty ExposeProcessEntityProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LabelProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IChildCollection ProcessActionsChildCollection { get; }

### interface IProcessTrigger : ITrigger

### interface ISchedule : IObject
- IScheduleDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- ISequence<IScheduleItem> ScheduleItems { get; }
- bool WhenPublished { get; set; }
- ISchedule Any<TScheduleItem>()
- ISchedule AtOrOn<TScheduleItem>(int[] values)
- ISchedule AtOrOn(DayOfWeek[] values)
- ISchedule AtOrOn(int hour, int minute)
- ISchedule Between<TScheduleItem>(int start, int end)
- ISchedule Between(DayOfWeek start, DayOfWeek end)
- IDayOfMonth CreateDayOfMonth(IKey key = null)
- IDayOfWeek CreateDayOfWeek(IKey key = null)
- IHour CreateHour(IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- IMinute CreateMinute(IKey key = null)
- IMonth CreateMonth(IKey key = null)
- ITimeOfDay CreateTimeOfDay(IKey key = null)
- IWeekOfMonth CreateWeekOfMonth(IKey key = null)
- ISchedule Every<TScheduleItem>(int[] values)
- ISchedule Every(DayOfWeek[] values)
- void FromCronExpression(string cronExpression)
- void FromLegacyExpression(string legacyExpression)
- void Reset()
- string ToCronExpression()
- string ToLegacyExpression()

### interface IScheduleDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }
- IChildCollection ScheduleItemsChildCollection { get; }
- IProperty WhenPublishedProperty { get; }

### interface IScheduleItem : IObject
- IScheduleItemDescriptor Descriptor { get; }
- ScheduleInterval Interval { get; set; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IScheduleItemDescriptor : IObjectDescriptor
- IProperty IntervalProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface ITimeOfDay : IScheduleItem
- ITimeOfDayDescriptor Descriptor { get; }
- int Hour { get; }
- int Minute { get; }

### interface ITimeOfDayDescriptor : IScheduleItemDescriptor

### interface ITimer : IObject
- IActionSignature Action { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- string CreatedBy { get; set; }
- string CronSchedule { get; set; }
- string Description { get; set; }
- ITimerDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- BooleanWithInheritance IsMultiTenant { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- Priority Priority { get; set; }
- string Schedule { get; set; }
- ISchedule ScheduleConfiguration { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- int? TimeoutInMinutes { get; set; }
- IActionSignature WakeTimerAction { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface ITimerDescriptor : IObjectDescriptor
- IProperty ActionProperty { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty CreatedByProperty { get; }
- IProperty CronScheduleProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty IsMultiTenantProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty PriorityProperty { get; }
- IChildCollection ScheduleConfigurationChildCollection { get; }
- IProperty ScheduleProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TimeoutInMinutesProperty { get; }
- IChildCollection TimerActionsChildCollection { get; }

### interface ITrigger
- EntityActionKind Action { get; set; }
- IEntitySignature Entity { get; set; }

### interface IWeekOfMonth : IScheduleItem
- IWeekOfMonthDescriptor Descriptor { get; }
- ICollection<int> WeekOfMonthValues { get; }

### interface IWeekOfMonthDescriptor : IScheduleItemDescriptor
- IProperty WeekOfMonthValuesProperty { get; }

## OutSystems.Model.Processes.Nodes

### interface IAutomaticActivityNode : IProcessNode
- string Description { get; set; }
- IAutomaticActivityNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IEnumerable<ILocalVariable> LocalVariables { get; }
- string Name { get; set; }
- IEnumerable<IActionNode> Nodes { get; }
- ISequence<IActivityOutputParameter> OutputParameters { get; }
- IExpression StartDate { get; }
- ICollection<IProcessNode> Targets { get; }
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActivityOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- void SetStartDate(ExpressionDefinition value)

### interface IAutomaticActivityNodeDescriptor : IProcessNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IExpressionProperty StartDateProperty { get; }
- IProperty TargetsProperty { get; }

### interface ICommentConnector : IProcessConnector
- ICommentConnectorDescriptor Descriptor { get; }
- string Label { get; set; }

### interface ICommentConnectorDescriptor : IProcessConnectorDescriptor
- IProperty LabelProperty { get; }

### interface ICommentNode : IProcessNode
- IEnumerable<ICommentConnector> Connectors { get; }
- ICommentNodeDescriptor Descriptor { get; }
- bool IsReminder { get; set; }
- string Text { get; set; }
- ICommentConnector CreateConnector(IProcessNode target)

### interface ICommentNodeDescriptor : IProcessNodeDescriptor
- IChildCollection ConnectorsChildCollection { get; }
- IProperty IsReminderProperty { get; }
- IProperty TextProperty { get; }

### interface IConditionalStartNode : IConditionalStartNodeSignature, IProcessNode, IShareableESpaceObject<IConditionalStartNode, IConditionalStartNodeSignature>
- string Description { get; set; }
- IConditionalStartNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- ICallback OnReady { get; }
- ICallback OnStart { get; }
- ISequence<IActivityOutputParameter> OutputParameters { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IActivityTrigger StartOn { get; }
- ICollection<IProcessNode> Targets { get; }
- ICallback CreateOnReady()
- ICallback CreateOnStart()
- IActivityOutputParameter CreateOutputParameter(string name = null, IKey key = null)

### interface IConditionalStartNodeDescriptor : IConditionalStartNodeSignatureDescriptor, IProcessNodeDescriptor
- IChildCollection ActivityCallbacksChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IProperty TargetsProperty { get; }

### interface IConditionalStartNodeSignature : IProcessNodeSignature
- string Description { get; }
- IConditionalStartNodeSignatureDescriptor Descriptor { get; }
- string Label { get; }
- string Name { get; set; }
- IEnumerable<IActivityOutputParameterSignature> OutputParameters { get; }
- IActionSignature StartActivityAction { get; }

### interface IConditionalStartNodeSignatureDescriptor : IProcessNodeSignatureDescriptor
- IChildCollection ActivityActionsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }

### interface IDecisionConnector : IProcessConnector
- IDecisionConnectorDescriptor Descriptor { get; }
- string Name { get; set; }

### interface IDecisionConnectorDescriptor : IProcessConnectorDescriptor
- IProperty NameProperty { get; }

### interface IDecisionNode : IProcessNode
- IEnumerable<IDecisionConnector> Connectors { get; }
- string Description { get; set; }
- IDecisionNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- IEnumerable<ILocalVariable> LocalVariables { get; }
- string Name { get; set; }
- IEnumerable<IActionNode> Nodes { get; }
- IDecisionConnector CreateConnector(string name, IProcessNode target)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- void SwapConnectors()

### interface IDecisionNodeDescriptor : IProcessNodeDescriptor
- IChildCollection ConnectorsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection NodesChildCollection { get; }

### interface IEndNode : IProcessNode
- IEndNodeDescriptor Descriptor { get; }
- bool TerminateProcess { get; set; }

### interface IEndNodeDescriptor : IProcessNodeDescriptor
- IProperty TerminateProcessProperty { get; }

### interface IExecuteProcessNode : IProcessNode
- IEnumerable<IArgument> Arguments { get; }
- string Description { get; set; }
- IExecuteProcessNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- string Name { get; set; }
- IProcessSignature Process { get; set; }
- ICollection<IProcessNode> Targets { get; }

### interface IExecuteProcessNodeDescriptor : IProcessNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IProperty ProcessProperty { get; }
- IProperty TargetsProperty { get; }

### interface IHumanActivityNode : IHumanActivityNodeSignature, IProcessNode, IShareableESpaceObject<IHumanActivityNode, IHumanActivityNodeSignature>
- bool AllowSkip { get; set; }
- IEnumerable<IArgument> Arguments { get; }
- IActivityTrigger CloseOn { get; }
- string Description { get; set; }
- IHumanActivityNodeDescriptor Descriptor { get; }
- IScreenSignature Destination { get; set; }
- IExpression DueDate { get; }
- string Instructions { get; set; }
- string Label { get; set; }
- ICallback OnClose { get; }
- ICallback OnOpen { get; }
- ICallback OnReady { get; }
- ICallback OnSkip { get; }
- ISequence<IActivityOutputParameter> OutputParameters { get; }
- bool Public { get; set; }
- ICollection<IRoleSignature> Roles { get; }
- bool Shareable { get; set; }
- IExpression StartDate { get; }
- ICollection<IProcessNode> Targets { get; }
- IExpression User { get; }
- ICallback CreateOnClose()
- ICallback CreateOnOpen()
- ICallback CreateOnReady()
- ICallback CreateOnSkip()
- IActivityOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- void SetDetail(ExpressionDefinition value)
- void SetDueDate(ExpressionDefinition value)
- void SetStartDate(ExpressionDefinition value)
- void SetUser(ExpressionDefinition value)

### interface IHumanActivityNodeDescriptor : IHumanActivityNodeSignatureDescriptor, IProcessNodeDescriptor
- IChildCollection ActivityCallbacksChildCollection { get; }
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DestinationProperty { get; }
- IExpressionProperty DueDateProperty { get; }
- IProperty PublicProperty { get; }
- IProperty RolesProperty { get; }
- IProperty ShareableProperty { get; }
- IExpressionProperty StartDateProperty { get; }
- IProperty TargetsProperty { get; }
- IExpressionProperty UserProperty { get; }

### interface IHumanActivityNodeSignature : IProcessNodeSignature
- bool AllowSkip { get; }
- IActionSignature CloseActivityAction { get; }
- string Description { get; }
- IHumanActivityNodeSignatureDescriptor Descriptor { get; }
- IExpression Detail { get; }
- string Instructions { get; }
- string Label { get; }
- string Name { get; set; }
- IEnumerable<IActivityOutputParameterSignature> OutputParameters { get; }

### interface IHumanActivityNodeSignatureDescriptor : IProcessNodeSignatureDescriptor
- IChildCollection ActivityActionsChildCollection { get; }
- IProperty AllowSkipProperty { get; }
- IProperty DescriptionProperty { get; }
- IExpressionProperty DetailProperty { get; }
- IProperty InstructionsProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }

### interface IProcessNode : IFlowNode, IProcessNodeSignature
- IEnumerable<IProcessConnector> Connectors { get; }
- string CreatedBy { get; set; }
- IProcessNodeDescriptor Descriptor { get; }
- IEnumerable<IProcessConnector> IncomingConnectors { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }

### interface IProcessNodeDescriptor : IFlowNodeDescriptor, IProcessNodeSignatureDescriptor

### interface IProcessNodeSignature : IFlowNodeSignature
- string CreatedBy { get; }
- IProcessNodeSignatureDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }

### interface IProcessNodeSignatureDescriptor : IFlowNodeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface ISendEmailNode : IProcessNode
- IEnumerable<IArgument> Arguments { get; }
- IExpression Bcc { get; }
- IExpression Cc { get; }
- string Description { get; set; }
- ISendEmailNodeDescriptor Descriptor { get; }
- IWebEmail Email { get; set; }
- IExpression From { get; }
- string Label { get; set; }
- bool LogContent { get; set; }
- string Name { get; set; }
- ICollection<IProcessNode> Targets { get; }
- IExpression To { get; }
- void SetBcc(ExpressionDefinition value)
- void SetCc(ExpressionDefinition value)
- void SetFrom(ExpressionDefinition value)
- void SetTo(ExpressionDefinition value)

### interface ISendEmailNodeDescriptor : IProcessNodeDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IExpressionProperty BccProperty { get; }
- IExpressionProperty CcProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EmailProperty { get; }
- IExpressionProperty FromProperty { get; }
- IProperty LabelProperty { get; }
- IProperty LogContentProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetsProperty { get; }
- IExpressionProperty ToProperty { get; }

### interface IStartNode : IProcessNode
- IStartNodeDescriptor Descriptor { get; }
- ICollection<IProcessNode> Targets { get; }

### interface IStartNodeDescriptor : IProcessNodeDescriptor
- IProperty TargetsProperty { get; }

### interface IWaitNode : IProcessNode, IShareableESpaceObject<IWaitNode, IWaitNodeSignature>, IWaitNodeSignature
- bool AllowSkip { get; set; }
- IActivityTrigger CloseOn { get; }
- string Description { get; set; }
- IWaitNodeDescriptor Descriptor { get; }
- string Label { get; set; }
- ICallback OnClose { get; }
- ICallback OnReady { get; }
- ICallback OnSkip { get; }
- ISequence<IActivityOutputParameter> OutputParameters { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- ICollection<IProcessNode> Targets { get; }
- ICallback CreateOnClose()
- ICallback CreateOnReady()
- ICallback CreateOnSkip()
- IActivityOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- void SetTimeout(ExpressionDefinition value)

### interface IWaitNodeDescriptor : IProcessNodeDescriptor, IWaitNodeSignatureDescriptor
- IChildCollection ActivityCallbacksChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IProperty TargetsProperty { get; }

### interface IWaitNodeSignature : IProcessNodeSignature
- bool AllowSkip { get; }
- IActionSignature CloseActivityAction { get; }
- string Description { get; }
- IWaitNodeSignatureDescriptor Descriptor { get; }
- string Label { get; }
- string Name { get; set; }
- IEnumerable<IActivityOutputParameterSignature> OutputParameters { get; }
- IExpression Timeout { get; }

### interface IWaitNodeSignatureDescriptor : IProcessNodeSignatureDescriptor
- IChildCollection ActivityActionsChildCollection { get; }
- IProperty AllowSkipProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LabelProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IExpressionProperty TimeoutProperty { get; }

## OutSystems.Model.Signatures

### class BinarySignatureInformation : SignatureInformation
- Byte[] SignatureBinary { get; set; }

### interface IA2AConnection : IModuleSignature
- IA2AConnectionDescriptor Descriptor { get; }
- IActionSignature CreateAction(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)

### interface IA2AConnectionDescriptor : IModuleSignatureWithActionsDescriptor

### interface IActionSignature : IShareableObjectSignature<IActionSignature, IActionSignature>
- IReadOnlyList<KeyValuePair<string, string>> AdditionalInformation { get; }
- string Description { get; set; }
- IActionSignatureDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- ISequence<IInputParameterSignature> InputParameters { get; }
- string IntegrationName { get; set; }
- bool IsFunction { get; set; }
- string Name { get; set; }
- ISequence<IOutputParameterSignature> OutputParameters { get; }
- void ClearAdditionalInformation()
- IInputParameterSignature CreateInputParameter(string name = null, IKey key = null)
- IOutputParameterSignature CreateOutputParameter(string name = null, IKey key = null)
- void RemoveAdditionalInformation(string key)
- void SetAdditionalInformation(string key, string value)

### interface IActionSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty IsFunctionProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OutputParametersChildCollection { get; }

### interface IAIModelActionSignature : IActionSignature
- string ModelVersion { get; set; }

### interface IAIModelConnection : IModuleSignature
- IEnumerable<IAIModelActionSignature> Actions { get; }
- IAIModelConnectionDescriptor Descriptor { get; }
- IAIModelActionSignature CreateAction(string name = null, IKey key = null)
- IEntitySignature CreateEntity(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)

### interface IAIModelConnectionDescriptor : IModuleSignatureWithActionsDescriptor, IModuleSignatureWithEntitiesDescriptor, IModuleSignatureWithStructuresDescriptor

### interface IAINativeConnection : IModuleSignature
- IAINativeConnectionDescriptor Descriptor { get; }
- IEnumerable<IRemoteMCPServerToolSignature> Tools { get; }
- IRemoteMCPServerToolSignature CreateTool(string name = null, IKey key = null)

### interface IAINativeConnectionDescriptor : IModuleSignatureWithActionsDescriptor

### interface IBasicType : ITypeSignature
- IBasicTypeDescriptor Descriptor { get; }

### interface IBasicTypeDescriptor : ITypeSignatureDescriptor

### interface IEntityAttributeSignature : IObjectSignature
- IBasicType DataType { get; set; }
- int? Decimals { get; set; }
- string DefaultValue { get; set; }
- string Description { get; set; }
- IEntityAttributeSignatureDescriptor Descriptor { get; }
- bool IsAutoNumber { get; set; }
- bool IsMandatory { get; set; }
- int? Length { get; set; }
- string Name { get; set; }

### interface IEntityAttributeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DecimalsProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsAutoNumberProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LengthProperty { get; }
- IProperty NameProperty { get; }

### interface IEntitySignature : IShareableObjectSignature<IEntitySignature, IEntitySignature>
- ISequence<IEntityAttributeSignature> Attributes { get; }
- string Description { get; set; }
- IEntitySignatureDescriptor Descriptor { get; }
- bool ExposeAsReadOnly { get; set; }
- bool HideCreateEntity { get; set; }
- bool HideCreateOrUpdateAllEntity { get; set; }
- bool HideCreateOrUpdateEntity { get; set; }
- bool HideDeleteAllEntity { get; set; }
- bool HideDeleteEntity { get; set; }
- bool HideGetEntity { get; set; }
- bool HideGetEntityForUpdate { get; set; }
- bool HideUpdateEntity { get; set; }
- IEntityAttributeSignature IdentifierAttribute { get; set; }
- IIdentifierType IdentifierType { get; }
- bool IsStaticEntity { get; }
- bool KeepDatabaseNulls { get; set; }
- string Name { get; set; }
- IEntityAttributeSignature CreateAttribute(string name = null, IKey key = null)

### interface IEntitySignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection AttributesChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty ExposeAsReadOnlyProperty { get; }
- IProperty HideCreateEntityProperty { get; }
- IProperty HideCreateOrUpdateAllEntityProperty { get; }
- IProperty HideCreateOrUpdateEntityProperty { get; }
- IProperty HideDeleteAllEntityProperty { get; }
- IProperty HideDeleteEntityProperty { get; }
- IProperty HideGetEntityForUpdateProperty { get; }
- IProperty HideGetEntityProperty { get; }
- IProperty HideUpdateEntityProperty { get; }
- IProperty IdentifierAttributeProperty { get; }
- IChildCollection IdentifierTypeChildCollection { get; }
- IProperty IsStaticEntityProperty { get; }
- IProperty KeepDatabaseNullsProperty { get; }
- IProperty NameProperty { get; }

### interface IExternalConnection : IModuleSignature
- IExternalConnectionDescriptor Descriptor { get; }
- bool IsValid { get; }
- IActionSignature CreateAction(string name = null, IKey key = null)
- IEntitySignature CreateEntity(string name = null, IKey key = null)
- IServiceActionSignature CreateServiceAction(string name = null, IKey key = null)
- IStaticEntitySignature CreateStaticEntity(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)
- IEnumerable<IValidationMessage> GetValidationMessages(bool includeMessagesFromDescendants = True)

### interface IExternalConnectionDescriptor : IModuleSignatureWithActionsDescriptor, IModuleSignatureWithEntitiesDescriptor, IModuleSignatureWithStructuresDescriptor

### interface IIdentifierType : IBasicType
- IIdentifierTypeDescriptor Descriptor { get; }
- IEntitySignature Entity { get; }

### interface IIdentifierTypeDescriptor : IBasicTypeDescriptor
- IProperty EntityProperty { get; }

### interface IInputParameterSignature : IShareableObjectSignature<IInputParameterSignature, IInputParameterSignature>
- ITypeSignature DataType { get; set; }
- string DefaultValue { get; set; }
- string Description { get; set; }
- IInputParameterSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; set; }
- bool IsMandatory { get; set; }
- string Name { get; set; }

### interface IInputParameterSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty NameProperty { get; }

### interface IKnowledgeBase : IModuleSignature
- IKnowledgeBaseDescriptor Descriptor { get; }
- IActionSignature CreateAction(string name = null, IKey key = null)
- IEntitySignature CreateEntity(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)

### interface IKnowledgeBaseDescriptor : IModuleSignatureWithActionsDescriptor, IModuleSignatureWithEntitiesDescriptor, IModuleSignatureWithStructuresDescriptor

### interface IListTypeSignature : ITypeSignature
- ITypeSignature ElementType { get; }

### interface IMCPConnection : IModuleSignature
- IEnumerable<IActionSignature> Actions { get; }
- IMCPConnectionDescriptor Descriptor { get; }
- IEnumerable<IStructureSignature> Structures { get; }
- IActionSignature CreateAction(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)

### interface IMCPConnectionDescriptor : IClassDescriptor
- IChildCollection ActionsChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty IconProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection StructuresChildCollection { get; }

### interface IModuleSignature : IObjectSignature
- IEnumerable<IActionSignature> Actions { get; }
- IBasicType BinaryDataType { get; }
- IBasicType BooleanType { get; }
- string CompatibilityDigest { get; }
- CreatedByTool CreatedByTool { get; }
- IBasicType CurrencyType { get; }
- IBasicType DateTimeType { get; }
- IBasicType DateType { get; }
- IBasicType DecimalType { get; }
- string Description { get; set; }
- IModuleSignatureDescriptor Descriptor { get; }
- string Digest { get; }
- IBasicType EmailType { get; }
- IEnumerable<IEntitySignature> Entities { get; }
- IBasicType FileType { get; }
- Byte[] Icon { get; set; }
- IBasicType IntegerIdentifierType { get; }
- IBasicType IntegerType { get; }
- IBasicType LongIntegerIdentifierType { get; }
- IBasicType LongIntegerType { get; }
- ReferenceKind ModuleKind { get; }
- SegmentationKind ModuleType { get; }
- string Name { get; set; }
- ITypeSignature ObjectType { get; }
- IBasicType PhoneNumberType { get; }
- string ProviderType { get; set; }
- IEnumerable<IServiceActionSignature> ServiceActions { get; }
- XElement Signature { get; }
- Byte[] SignatureBinary { get; }
- Guid SignatureDigest { get; }
- IEnumerable<IStructureSignature> Structures { get; }
- IBasicType TextIdentifierType { get; }
- IBasicType TextType { get; }
- IBasicType TimeType { get; }
- IListTypeSignature GetOrCreateListType(ITypeSignature typeSignature)
- Byte[] Save()
- void Save(string path)

### interface IModuleSignatureDescriptor : IClassDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IconProperty { get; }
- IProperty NameProperty { get; }

### interface IModuleSignatureWithActionsDescriptor : IModuleSignatureDescriptor
- IChildCollection ActionsChildCollection { get; }

### interface IModuleSignatureWithEntitiesDescriptor : IModuleSignatureDescriptor
- IChildCollection EntitiesChildCollection { get; }

### interface IModuleSignatureWithStructuresDescriptor : IModuleSignatureDescriptor
- IChildCollection StructuresChildCollection { get; }

### interface IObjectSignature : IModelObject
- IObjectSignatureDescriptor Descriptor { get; }
- IKey ObjectKey { get; }
- IModuleSignature GetModuleSignature()

### interface IObjectSignatureDescriptor

### interface IOutputParameterSignature : IShareableObjectSignature<IOutputParameterSignature, IOutputParameterSignature>
- ITypeSignature DataType { get; set; }
- string DefaultValue { get; set; }
- string Description { get; set; }
- IOutputParameterSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; set; }
- string Name { get; set; }

### interface IOutputParameterSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface IRemoteMCPServerToolSignature : IActionSignature
- string ToolSchema { get; set; }

### interface ISearchServiceConnection : IModuleSignature
- ISearchServiceConnectionDescriptor Descriptor { get; }
- IActionSignature CreateAction(string name = null, IKey key = null)
- IEntitySignature CreateEntity(string name = null, IKey key = null)
- IStructureSignature CreateStructure(string name = null, IKey key = null)

### interface ISearchServiceConnectionDescriptor : IModuleSignatureWithActionsDescriptor, IModuleSignatureWithEntitiesDescriptor, IModuleSignatureWithStructuresDescriptor

### interface IServiceActionSignature : IActionSignature

### interface IShareableObjectSignature : IObjectSignature, IShareable

### interface IShareableObjectSignature<ConcreteT, SignatureT> : IShareableObjectSignature

### interface IStaticEntityRecordSignature : IObjectSignature
- ISequence<IStaticRecordAttributeValueSignature> AttributeValues { get; }
- IStaticEntityRecordSignature.IStaticEntityRecordSignatureDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- string Name { get; set; }

### interface IStaticEntitySignature : IEntitySignature, IShareableObjectSignature<IStaticEntitySignature, IStaticEntitySignature>
- IStaticEntitySignature.IStaticEntitySignatureDescriptor Descriptor { get; }
- ISequence<IStaticEntityRecordSignature> Records { get; }
- IStaticEntityRecordSignature CreateRecord(string name = null, IKey key = null)

### interface IStaticRecordAttributeValueSignature : IObjectSignature
- IEntityAttributeSignature Attribute { get; }
- IStaticRecordAttributeValueSignature.IStaticRecordAttributeValueSignatureDescriptor Descriptor { get; }
- string Value { get; }
- void SetValue(string value)

### interface IStructureAttributeSignature : IShareableObjectSignature<IStructureAttributeSignature, IStructureAttributeSignature>
- ITypeSignature DataType { get; set; }
- int? Decimals { get; set; }
- string DefaultValue { get; set; }
- string Description { get; set; }
- IStructureAttributeSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; set; }
- bool IsMandatory { get; set; }
- string Label { get; set; }
- int? Length { get; set; }
- string Name { get; set; }
- string NameInJSON { get; set; }

### interface IStructureAttributeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DecimalsProperty { get; }
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LabelProperty { get; }
- IProperty LengthProperty { get; }
- IProperty NameInJSONProperty { get; }
- IProperty NameProperty { get; }

### interface IStructureSignature : IShareableObjectSignature<IStructureSignature, IStructureSignature>, ITypeSignature
- ISequence<IStructureAttributeSignature> Attributes { get; }
- string Description { get; set; }
- IStructureSignatureDescriptor Descriptor { get; }
- string IntegrationName { get; set; }
- string Name { get; set; }
- IStructureAttributeSignature CreateAttribute(string name = null, IKey key = null)

### interface IStructureSignatureDescriptor : IObjectSignatureDescriptor
- IChildCollection AttributesChildCollection { get; }
- IProperty DescriptionProperty { get; }
- IProperty NameProperty { get; }

### interface ITypeSignature : IObjectSignature
- ITypeSignatureDescriptor Descriptor { get; }

### interface ITypeSignatureDescriptor : IObjectSignatureDescriptor

### class ResolveModelSignatureEventArgs : EventArgs
- IKey ModuleKey { get; }
- string SpecificVersionHash { get; }

### class ResolveModuleSignatureEventHandler : MulticastDelegate, ICloneable, ISerializable
- IAsyncResult BeginInvoke(object sender, ResolveModelSignatureEventArgs args, AsyncCallback callback, object object)
- SignatureInformation EndInvoke(IAsyncResult result)
- SignatureInformation Invoke(object sender, ResolveModelSignatureEventArgs args)

### class SignatureInformation : SignatureMetadata
- IKey AppKey { get; set; }
- string Digest { get; set; }
- string ExtensibilityConfigurations { get; set; }
- Byte[] Icon { get; set; }
- string JQueryVersion { get; set; }
- string Revision { get; set; }
- IEnumerable<IKey> TargetElementKeys { get; set; }
- string Version { get; set; }

### class SignatureMetadata
- string Description { get; set; }
- IKey Key { get; set; }
- ReferenceKind ModuleKind { get; set; }
- SegmentationKind ModuleType { get; set; }
- string Name { get; set; }

### class StreamSignatureInformation : SignatureInformation
- Stream SignatureStream { get; set; }

## OutSystems.Model.Types

### interface IAnonymousStructure : IRecordType
- IEnumerable<IAttributeSignature> Attributes { get; }
- IAnonymousStructureDescriptor Descriptor { get; }

### interface IAnonymousStructureDescriptor : IRecordTypeDescriptor

### interface IAttribute : IAttributeSignature, IObject
- ITypeSignature DataType { get; set; }
- int? Decimals { get; set; }
- string Description { get; set; }
- IAttributeDescriptor Descriptor { get; }
- bool IsMandatory { get; set; }
- int? Length { get; set; }
- string Name { get; set; }
- void SetDefaultValue(ExpressionDefinition value)

### interface IAttributeDescriptor : IAttributeSignatureDescriptor, IObjectDescriptor

### interface IAttributeSignature : IObjectSignature
- ITypeSignature DataType { get; }
- int? Decimals { get; }
- IExpression DefaultValue { get; }
- string Description { get; }
- IAttributeSignatureDescriptor Descriptor { get; }
- bool IsMandatory { get; }
- int? Length { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IAttributeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DataTypeProperty { get; }
- IProperty DecimalsProperty { get; }
- IExpressionProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LengthProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IBasicType : IType
- IBasicTypeDescriptor Descriptor { get; }

### interface IBasicTypeDescriptor : ITypeDescriptor

### interface IGenericType : IType
- IGenericTypeDescriptor Descriptor { get; }
- int GenericIndex { get; }

### interface IGenericTypeDescriptor : ITypeDescriptor
- IProperty GenericIndexProperty { get; }

### interface IIdentifierType : IBasicType
- IIdentifierTypeDescriptor Descriptor { get; }
- IEntitySignature Entity { get; }

### interface IIdentifierTypeDescriptor : IBasicTypeDescriptor

### interface IListType : IType
- IListTypeDescriptor Descriptor { get; }
- ITypeSignature ElementType { get; }

### interface IListTypeDescriptor : ITypeDescriptor
- IProperty ElementTypeProperty { get; }

### interface IRecordType : IRecordTypeSignature, IType
- IEnumerable<IAttribute> Attributes { get; }
- IRecordTypeDescriptor Descriptor { get; }

### interface IRecordTypeDescriptor : IRecordTypeSignatureDescriptor, ITypeDescriptor

### interface IRecordTypeSignature : ITypeSignature
- IEnumerable<IAttributeSignature> Attributes { get; }
- IRecordTypeSignatureDescriptor Descriptor { get; }

### interface IRecordTypeSignatureDescriptor : ITypeSignatureDescriptor
- IChildCollection AttributesChildCollection { get; }

### interface IType : IObject, ITypeSignature
- ITypeDescriptor Descriptor { get; }

### interface ITypeDescriptor : IObjectDescriptor, ITypeSignatureDescriptor

### interface ITypeSignature : IEquatable<ITypeSignature>, IObjectSignature
- ITypeSignatureDescriptor Descriptor { get; }
- bool IsDisabled { get; }
- TypeKind Kind { get; }
- Guid UniqueId { get; }
- bool IsAssignableTo(ITypeSignature other)
- bool IsAssignableTo(IBasicType other)

### interface ITypeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty IsDisabledProperty { get; }
- IProperty UniqueIdProperty { get; }

### enum TypeKind
- None
- Boolean
- Text
- PhoneNumber
- Email
- Integer
- LongInteger
- Decimal
- Currency
- Date
- Time
- DateTime
- BinaryData
- Record
- List
- LambdaExpression
- IntegerIdentifier
- LongIntegerIdentifier
- TextIdentifier
- Object
- CSharp
- File
- Basic
- Any

## OutSystems.Model.UI

### interface IBlock : IBlockSignature, IShareableESpaceObject<IBlock, IBlockSignature>, IUIFlowNode
- string CreatedBy { get; set; }
- string Description { get; set; }
- IBlockDescriptor Descriptor { get; }
- IEnumerable<IBlockEvent> Events { get; }
- Byte[] Icon { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string JavaScript { get; set; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- string StyleSheet { get; set; }
- ISequence<IWidget> Widgets { get; }
- IBlockEvent CreateEvent(string name = null, IKey key = null)
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- IWidget CreateWidget(Type type, string name = null, IKey key = null)
- void SetOnRenderJavascript(ExpressionDefinition value)

### interface IBlockDescriptor : IBlockSignatureDescriptor, IUIFlowNodeDescriptor
- IChildCollection LocalVariablesChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }

### interface IBlockEvent : IBlockEventSignature, IObject, ITriggerableEvent
- string Description { get; set; }
- IBlockEventDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- bool IsMandatory { get; set; }
- string Name { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IBlockEventDescriptor : IBlockEventSignatureDescriptor, IObjectDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IBlockEventSignature : IObjectSignature
- string Description { get; }
- IBlockEventSignatureDescriptor Descriptor { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- bool IsMandatory { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IBlockEventSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty IsMandatoryProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IBlockSignature : IUIFlowNodeSignature
- string CreatedBy { get; }
- string Description { get; }
- IBlockSignatureDescriptor Descriptor { get; }
- IEnumerable<IBlockEventSignature> Events { get; }
- bool Hidden { get; }
- Byte[] Icon { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string JavaScript { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- string Name { get; set; }
- IExpression OnRenderJavascript { get; }
- string StyleSheet { get; }
- IEnumerable<IWidgetSignature> Widgets { get; }

### interface IBlockSignatureDescriptor : IUIFlowNodeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection EventsChildCollection { get; }
- IProperty HiddenProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty JavaScriptProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty OnRenderJavascriptProperty { get; }
- IProperty StyleSheetProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IEmail : IUIFlowNode
- string CreatedBy { get; set; }
- string Description { get; set; }
- IEmailDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- string Name { get; set; }
- IExpression Subject { get; }
- ISequence<IWidget> Widgets { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- IWidget CreateWidget(Type type, string name = null, IKey key = null)
- void SetSubject(ExpressionDefinition value)

### interface IEmailDescriptor : IUIFlowNodeDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SubjectProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IEventHandler : IObject
- IEnumerable<IArgument> Arguments { get; }
- IEventHandlerDescriptor Descriptor { get; }
- IBlockEventSignature Event { get; }
- IObjectSignature Handler { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IEventHandlerDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty EventProperty { get; }
- IProperty HandlerProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IFlexBoxChildLayout : IWidgetSignature
- AlignSelf AlignSelf { get; }
- string FlexBasis { get; }
- Flexible Flexible { get; }

### interface IFlexBoxLayout : IWidgetSignature
- AlignItems AlignItems { get; }
- FlexDirection FlexDirection { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- JustifyContent JustifyContent { get; }

### interface IGridBoxChildLayout : IWidgetSignature
- int? ColumnSpan { get; }
- int? RowSpan { get; }

### interface IGridBoxLayout : IWidgetSignature
- string ColumnGap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- string RowGap { get; }

### interface IGridLayout
- IEnumerable<string> CssClasses { get; }
- string MarginLeftDimension { get; }
- string WidthDimension { get; }

### interface IImage : IImageSignature, IShareableESpaceObject<IImage, IImageSignature>
- string CreatedBy { get; set; }
- string Description { get; set; }
- IImageDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<ILocalizedImage> LocalizedImages { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- ILocalizedImage CreateLocalizedImage(ILocale locale, Byte[] binary, string originalPath, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetImageContent(Byte[] binary, string originalPath)
- void SetImageContent(Byte[] binary, string originalPath, ImageFormat format, int width, int height)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IImageDescriptor : IImageSignatureDescriptor, IObjectDescriptor
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IImageSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IImageSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- int Height { get; }
- bool Hidden { get; }
- Byte[] ImageContent { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- IEnumerable<ILocalizedImageSignature> LocalizedImages { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- string OriginalFilename { get; }
- ImageFormat OriginalFormat { get; }
- string RuntimePath { get; }
- int Width { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IImageSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty HeightProperty { get; }
- IProperty HiddenProperty { get; }
- IProperty ImageContentProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection LocalizedImagesChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty OriginalFilenameProperty { get; }
- IProperty OriginalFormatProperty { get; }
- IProperty RuntimePathProperty { get; }
- IProperty WidthProperty { get; }

### interface ILocalizedImage : ILocalizedImageSignature, IObject
- ILocalizedImageDescriptor Descriptor { get; }
- ILocale Locale { get; set; }
- void SetImageContent(Byte[] binary, string originalPath)

### interface ILocalizedImageDescriptor : ILocalizedImageSignatureDescriptor, IObjectDescriptor
- IProperty LocaleProperty { get; }

### interface ILocalizedImageSignature : IObjectSignature
- ILocalizedImageSignatureDescriptor Descriptor { get; }
- Byte[] ImageContent { get; }
- ISequence<IMetadata> Metadata { get; }
- ImageFormat OriginalFormat { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface ILocalizedImageSignatureDescriptor : IObjectSignatureDescriptor
- IProperty ImageContentProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty OriginalFormatProperty { get; }

### enum ImageFormat
- Png
- Jpg
- Gif
- Ico
- Svg
- Unknown

### interface IOnExceptionAction : IOnExceptionActionSignature, IShareableESpaceObject<IOnExceptionAction, IOnExceptionActionSignature>
- string CreatedBy { get; set; }
- string Description { get; set; }
- IOnExceptionActionDescriptor Descriptor { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- IEnumerable<IActionNode> Nodes { get; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IOnExceptionActionDescriptor : IObjectDescriptor, IOnExceptionActionSignatureDescriptor
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection NodesChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IOnExceptionActionSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IOnExceptionActionSignatureDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IOnExceptionActionSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }

### interface IScreen : IScreenSignature, IShareableESpaceObject<IScreen, IScreenSignature>, IUIFlowNode
- string CreatedBy { get; set; }
- string Description { get; set; }
- IScreenDescriptor Descriptor { get; }
- Byte[] Icon { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- bool Public { get; set; }
- ICollection<IRoleSignature> Roles { get; }
- bool Shareable { get; set; }
- string StyleSheet { get; set; }
- ISequence<IWidget> Widgets { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- IWidget CreateWidget(Type type, string name = null, IKey key = null)
- void ReplaceEntity(IEntitySignature oldEntity, IEntitySignature newEntity, Dictionary<IEntityAttributeSignature, IEntityAttributeSignature> attributesMapping = null)

### interface IScreenDescriptor : IScreenSignatureDescriptor, IUIFlowNodeDescriptor
- IChildCollection LocalVariablesChildCollection { get; }
- IProperty PublicProperty { get; }
- IProperty RolesProperty { get; }
- IProperty ShareableProperty { get; }
- IProperty StyleSheetProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IScreenSignature : IUIFlowNodeSignature
- string CreatedBy { get; }
- string Description { get; }
- IScreenSignatureDescriptor Descriptor { get; }
- Byte[] Icon { get; }
- IEnumerable<IInputParameterSignature> InputParameters { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- string Name { get; set; }

### interface IScreenSignatureDescriptor : IUIFlowNodeSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IconProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty NameProperty { get; }

### interface IScript : IScriptSignature, IShareableESpaceObject<IScript, IScriptSignature>
- string CreatedBy { get; set; }
- string Description { get; set; }
- IScriptDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- bool HasSyntaxErrors { get; set; }
- string JavaScript { get; set; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- bool Public { get; set; }
- ICollection<IScriptSignature> RequiredScripts { get; }
- bool Shareable { get; set; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IScriptDescriptor : IObjectDescriptor, IScriptSignatureDescriptor
- IProperty HasSyntaxErrorsProperty { get; }
- IProperty JavaScriptProperty { get; }
- IProperty PublicProperty { get; }
- IProperty RequiredScriptsProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IScriptSignature : IObjectSignature
- string CreatedBy { get; }
- string Description { get; }
- IScriptSignatureDescriptor Descriptor { get; }
- IFolderSignature Folder { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<IScriptSignature> RequiredScripts { get; }
- string RuntimePath { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IScriptSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty RuntimePathProperty { get; }

### interface ITheme : IShareableESpaceObject<ITheme, IThemeSignature>, IThemeSignature
- IThemeSignature BaseTheme { get; set; }
- int Columns { get; set; }
- int ColumnWidth { get; set; }
- string CreatedBy { get; set; }
- string Description { get; set; }
- IThemeDescriptor Descriptor { get; }
- IFolder Folder { get; set; }
- IBlockSignature Footer { get; set; }
- GridType GridType { get; set; }
- int GutterWidth { get; set; }
- int GutterWidthPercentage { get; set; }
- IBlockSignature Header { get; set; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IBlockSignature Layout { get; set; }
- int? MaxWidth { get; set; }
- IBlockSignature Menu { get; set; }
- int? MinWidth { get; set; }
- bool Public { get; set; }
- bool Shareable { get; set; }
- string StyleSheet { get; set; }
- ITextWithReferencedElements StyleSheetExpression { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- IEnumerable<IThemeValues> ThemeValues { get; }
- void AddOrUpdateThemeValues(Dictionary<ThemeProperty, string> properties)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IThemeDescriptor : IObjectDescriptor, IThemeSignatureDescriptor
- IProperty PublicProperty { get; }
- IProperty ShareableProperty { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IThemeSignature : IObjectSignature
- IThemeSignature BaseTheme { get; }
- int Columns { get; }
- int ColumnWidth { get; }
- string CreatedBy { get; }
- string Description { get; }
- IThemeSignatureDescriptor Descriptor { get; }
- IThemeSignature FirstThemeWithGrid { get; }
- IFolderSignature Folder { get; }
- IBlockSignature Footer { get; }
- string GeneratedStyleSheet { get; }
- GridType GridType { get; }
- int GutterWidth { get; }
- int GutterWidthPercentage { get; }
- IBlockSignature Header { get; }
- string InvisibleStyleSheet { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- IBlockSignature Layout { get; }
- int? MaxWidth { get; }
- IBlockSignature Menu { get; }
- ISequence<IMetadata> Metadata { get; }
- int? MinWidth { get; }
- string Name { get; set; }
- string StyleSheet { get; }
- IEnumerable<IThemeValuesSignature> ThemeValues { get; }
- int TotalWidth { get; }
- string UserStyleSheet { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IThemeSignatureDescriptor : IObjectSignatureDescriptor
- IProperty BaseThemeProperty { get; }
- IProperty ColumnsProperty { get; }
- IProperty ColumnWidthProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty FolderProperty { get; }
- IProperty FooterProperty { get; }
- IProperty GeneratedStyleSheetProperty { get; }
- IProperty GridTypeProperty { get; }
- IProperty GutterWidthPercentageProperty { get; }
- IProperty GutterWidthProperty { get; }
- IProperty HeaderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty LayoutProperty { get; }
- IProperty MaxWidthProperty { get; }
- IProperty MenuProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty MinWidthProperty { get; }
- IProperty NameProperty { get; }
- IProperty StyleSheetProperty { get; }
- IChildCollection ThemeValuesChildCollection { get; }
- IProperty TotalWidthProperty { get; }
- IProperty UserStyleSheetProperty { get; }

### interface IUIFlow : IFlow, IShareableESpaceObject<IUIFlow, IUIFlowSignature>, IUIFlowSignature
- string CreatedBy { get; set; }
- string Description { get; set; }
- IUIFlowDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<IUIFlowNode> Nodes { get; }
- IOnExceptionAction OnExceptionHandler { get; }
- IThemeSignature Theme { get; set; }
- void ArrangeAllNodes()
- IBlock CreateBlock(string name = null, IKey key = null)
- IEmail CreateEmail(string name = null, IKey key = null)
- IOnExceptionAction CreateOnExceptionHandler(string name = null)
- IScreen CreateScreen(string name = null, IKey key = null)
- IEnumerable<IScreen> Instantiate(IEnumerable<IScreen> templateScreens, IEnumerable<IKey> newScreensKeys = null)
- IScreen Instantiate(IScreen templateScreen, IKey newScreenKey = null)
- IEnumerable<IEmail> Instantiate(IEnumerable<IEmail> templateEmails, IEnumerable<IKey> newEmailsKeys = null)
- IEmail Instantiate(IEmail templateEmail, IKey newEmailKey = null)

### interface IUIFlowConnector : IConnector
- IUIFlowConnectorDescriptor Descriptor { get; }
- IUIFlowNode Source { get; }
- IUIFlowNode Target { get; set; }

### interface IUIFlowConnectorDescriptor : IConnectorDescriptor

### interface IUIFlowDescriptor : IFlowDescriptor, IUIFlowSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ThemeProperty { get; }

### interface IUIFlowNode : IFlowNode, IUIFlowNodeSignature
- IEnumerable<IUIFlowConnector> Connectors { get; }
- IUIFlowNodeDescriptor Descriptor { get; }
- IEnumerable<IUIFlowConnector> IncomingConnectors { get; }

### interface IUIFlowNodeDescriptor : IFlowNodeDescriptor, IUIFlowNodeSignatureDescriptor

### interface IUIFlowNodeSignature : IFlowNodeSignature
- IUIFlowNodeSignatureDescriptor Descriptor { get; }

### interface IUIFlowNodeSignatureDescriptor : IFlowNodeSignatureDescriptor

### interface IUIFlowSignature : IFlowSignature
- string CreatedBy { get; }
- string Description { get; }
- IUIFlowSignatureDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; }
- DateTime LastModifiedDate { get; }
- IEnumerable<IUIFlowNodeSignature> Nodes { get; }
- IOnExceptionActionSignature OnExceptionHandler { get; }

### interface IUIFlowSignatureDescriptor : IFlowSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection OnExceptionHandlerChildCollection { get; }

### interface IWidget : IObject, IWidgetSignature
- string CustomStyle { get; set; }
- IWidgetDescriptor Descriptor { get; }
- IEnumerable<ITextResource> TextResources { get; }
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- void Delete(bool preserveChildren)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IWidgetDefinitionPlaceholderSignature : IObjectSignature
- string Description { get; }
- IWidgetDefinitionPlaceholderSignatureDescriptor Descriptor { get; }
- bool IsIterated { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- string SourceProperty { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IWidgetDefinitionPlaceholderSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IsIteratedProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty SourcePropertyProperty { get; }

### interface IWidgetDefinitionPropertySignature : IObjectSignature
- string DefaultValue { get; }
- string Description { get; }
- IWidgetDefinitionPropertySignatureDescriptor Descriptor { get; }
- bool IsMandatory { get; }
- string LambdaExpressionSourceProperty { get; }
- LambdaExpressionTarget LambdaExpressionTarget { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; }
- ModelPropertyKind PropertyKind { get; }
- PropertyRuntimeType RuntimeType { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IWidgetDefinitionPropertySignatureDescriptor : IObjectSignatureDescriptor
- IProperty DefaultValueProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty LambdaExpressionSourcePropertyProperty { get; }
- IProperty LambdaExpressionTargetProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty PropertyKindProperty { get; }
- IProperty RuntimeTypeProperty { get; }

### interface IWidgetDefinitionRequiredResourceSignature : IObjectSignature
- string Description { get; }
- IWidgetDefinitionRequiredResourceSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IKey ResourceKey { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IWidgetDefinitionRequiredResourceSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty ResourceKeyProperty { get; }

### interface IWidgetDefinitionSignature : IObjectSignature
- string Description { get; }
- IWidgetDefinitionSignatureDescriptor Descriptor { get; }
- bool HasValidationProperties { get; }
- bool IsValidationAggregator { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<IWidgetDefinitionPlaceholderSignature> Placeholders { get; }
- IEnumerable<IWidgetDefinitionPropertySignature> Properties { get; }
- IEnumerable<IWidgetDefinitionRequiredResourceSignature> RequiredResources { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IWidgetDefinitionSignatureDescriptor : IObjectSignatureDescriptor
- IProperty DescriptionProperty { get; }
- IProperty HasValidationPropertiesProperty { get; }
- IProperty IsValidationAggregatorProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection PlaceholdersChildCollection { get; }
- IChildCollection PropertiesChildCollection { get; }
- IChildCollection RequiredResourcesChildCollection { get; }

### interface IWidgetDescriptor : IObjectDescriptor, IWidgetSignatureDescriptor
- IChildCollection TextResourcesChildCollection { get; }

### interface IWidgetSignature : IObjectSignature
- string CustomStyle { get; }
- IWidgetSignatureDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IWidgetSignatureDescriptor : IObjectSignatureDescriptor
- IProperty CustomStyleProperty { get; }
- IChildCollection MetadataChildCollection { get; }

### interface IWidgetWithGridProperties : IWidgetSignature
- IGridLayout GridLayout { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string Width { get; }

## OutSystems.Model.UI.Mobile

### interface IComment : IMobileFlowNode
- IEnumerable<ICommentConnector> Connectors { get; }
- string CreatedBy { get; set; }
- ICommentDescriptor Descriptor { get; }
- bool IsReminder { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Text { get; set; }
- ICommentConnector CreateConnector(IMobileFlowNode target)

### interface ICommentConnector : IMobileFlowConnector
- ICommentConnectorDescriptor Descriptor { get; }
- string Label { get; set; }

### interface ICommentConnectorDescriptor : IMobileFlowConnectorDescriptor
- IProperty LabelProperty { get; }

### interface ICommentDescriptor : IMobileFlowNodeDescriptor
- IProperty CreatedByProperty { get; }
- IProperty IsReminderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty TextProperty { get; }

### interface IDataAction : IFlow
- IDataActionDescriptor Descriptor { get; }
- DataSourceFetch Fetch { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- IEnumerable<IActionNode> Nodes { get; }
- IUILifeCycleEvent OnAfterFetch { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- int? ServerRequestTimeout { get; set; }
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)

### interface IDataActionDescriptor : IFlowDescriptor
- IProperty FetchProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection OnAfterFetchChildCollection { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IProperty ServerRequestTimeoutProperty { get; }

### interface IExternalSite : IMobileFlowNode
- string Description { get; set; }
- IExternalSiteDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- string Name { get; set; }
- string URL { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)

### interface IExternalSiteDescriptor : IMobileFlowNodeDescriptor
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty NameProperty { get; }
- IProperty URLProperty { get; }

### interface IMobileBlock : IBlock, IMobileBlockSignature, IMobileFlowNode, IShareableESpaceObject<IMobileBlock, IMobileBlockSignature>
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- IEnumerable<IDataAction> DataActions { get; }
- IMobileBlockDescriptor Descriptor { get; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- IUILifeCycleEvent OnDestroy { get; }
- IUILifeCycleEvent OnInitialize { get; }
- IUILifeCycleEvent OnParametersChanged { get; }
- IUILifeCycleEvent OnReady { get; }
- IUILifeCycleEvent OnRender { get; }
- IOnSyncCompleteEvent OnSyncComplete { get; }
- IOnSyncErrorEvent OnSyncError { get; }
- IOnSyncStartEvent OnSyncStart { get; }
- ICollection<IScriptSignature> RequiredScripts { get; }
- IEnumerable<IScreenAction> ScreenActions { get; }
- IEnumerable<IScreenAggregate> ScreenAggregates { get; }
- ICollection<IUIFlowNode> Targets { get; }
- ISequence<IMobileWidget> Widgets { get; }
- IDataAction CreateDataAction(string name = null, IKey key = null)
- IOnSyncCompleteEvent CreateOnSyncComplete()
- IOnSyncErrorEvent CreateOnSyncError()
- IOnSyncStartEvent CreateOnSyncStart()
- IScreenAction CreateScreenAction(string name = null, IKey key = null)
- IScreenAggregate CreateScreenAggregate(bool isClientSide, string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)

### interface IMobileBlockDescriptor : IBlockDescriptor, IMobileBlockSignatureDescriptor, IMobileFlowNodeDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IChildCollection DataActionsChildCollection { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IChildCollection OnDestroyChildCollection { get; }
- IChildCollection OnInitializeChildCollection { get; }
- IChildCollection OnParametersChangedChildCollection { get; }
- IChildCollection OnReadyChildCollection { get; }
- IChildCollection OnRenderChildCollection { get; }
- IChildCollection OnSyncCompleteChildCollection { get; }
- IChildCollection OnSyncErrorChildCollection { get; }
- IChildCollection OnSyncStartChildCollection { get; }
- IProperty RequiredScriptsProperty { get; }
- IChildCollection ScreenActionsChildCollection { get; }
- IChildCollection ScreenAggregatesChildCollection { get; }
- IProperty TargetsProperty { get; }

### interface IMobileBlockSignature : IBlockSignature, IMobileFlowNodeSignature
- IMobileBlockSignatureDescriptor Descriptor { get; }
- bool HasScreenDestination { get; }
- IEnumerable<IRequiredModelPlugin> RequiredModelPlugins { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IMobileBlockSignatureDescriptor : IBlockSignatureDescriptor, IMobileFlowNodeSignatureDescriptor
- IProperty HasScreenDestinationProperty { get; }
- IProperty RequiredModelPluginsProperty { get; }

### interface IMobileEmail : IEmail, IMobileFlowNode
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- IMobileEmailDescriptor Descriptor { get; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- ICollection<IUIFlowNode> Targets { get; }
- ISequence<IMobileWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)

### interface IMobileEmailDescriptor : IEmailDescriptor, IMobileFlowNodeDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IProperty TargetsProperty { get; }

### interface IMobileFlow : IMobileFlowSignature, IShareableESpaceObject<IMobileFlow, IMobileFlowSignature>, IUIFlow
- string CreatedBy { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- string Description { get; set; }
- IMobileFlowDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- DateTime LastModifiedDate { get; set; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- IEnumerable<IMobileFlowNode> Nodes { get; }
- IMobileThemeSignature Theme { get; set; }
- IMobileBlock CreateBlock(string name = null, IKey key = null)
- IMobileEmail CreateEmail(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IMobileScreen CreateScreen(string name = null, IKey key = null)
- IMobileScreen Instantiate(IMobileScreen templateScreen, IKey newScreenKey = null)
- IEnumerable<IMobileScreen> Instantiate(IEnumerable<IMobileScreen> templateScreens, IEnumerable<IKey> newScreensKeys = null)

### interface IMobileFlowConnector : IUIFlowConnector
- IMobileFlowConnectorDescriptor Descriptor { get; }
- IMobileFlowNode Source { get; }
- IMobileFlowNode Target { get; set; }

### interface IMobileFlowConnectorDescriptor : IUIFlowConnectorDescriptor

### interface IMobileFlowDescriptor : IMobileFlowSignatureDescriptor, IUIFlowDescriptor
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }

### interface IMobileFlowNode : IMobileFlowNodeSignature, IUIFlowNode
- IMobileFlowNodeDescriptor Descriptor { get; }

### interface IMobileFlowNodeDescriptor : IMobileFlowNodeSignatureDescriptor, IUIFlowNodeDescriptor

### interface IMobileFlowNodeSignature : IUIFlowNodeSignature
- IMobileFlowNodeSignatureDescriptor Descriptor { get; }

### interface IMobileFlowNodeSignatureDescriptor : IUIFlowNodeSignatureDescriptor

### interface IMobileFlowSignature : IUIFlowSignature
- IMobileFlowSignatureDescriptor Descriptor { get; }
- string IconLibrary { get; }
- IEnumerable<IMobileFlowNodeSignature> Nodes { get; }

### interface IMobileFlowSignatureDescriptor : IUIFlowSignatureDescriptor
- IProperty IconLibraryProperty { get; }
- IChildCollection NodesChildCollection { get; }

### interface IMobileScreen : IMobileFlowNode, IMobileScreenSignature, IScreen, IShareableESpaceObject<IMobileScreen, IMobileScreenSignature>
- bool AnonymousAccess { get; set; }
- string CreatedByAgent { get; }
- CreatedByTool CreatedByTool { get; }
- bool CustomURL { get; set; }
- IEnumerable<IDataAction> DataActions { get; }
- IMobileScreenDescriptor Descriptor { get; }
- string LastModifiedByAgent { get; }
- CreatedByTool LastModifiedByTool { get; }
- IReadOnlyList<string> ModifiedByAgents { get; }
- CreatedByTool ModifiedByTools { get; }
- IUILifeCycleEvent OnDestroy { get; }
- IUILifeCycleEvent OnInitialize { get; }
- IUILifeCycleEvent OnReady { get; }
- IUILifeCycleEvent OnRender { get; }
- IOnSyncCompleteEvent OnSyncComplete { get; }
- IOnSyncErrorEvent OnSyncError { get; }
- IOnSyncStartEvent OnSyncStart { get; }
- string PageName { get; set; }
- ICollection<IScriptSignature> RequiredScripts { get; }
- IEnumerable<IScreenAction> ScreenActions { get; }
- IEnumerable<IScreenAggregate> ScreenAggregates { get; }
- ICollection<IUIFlowNode> Targets { get; }
- IExpression Title { get; }
- URLStructure URLStructure { get; set; }
- ISequence<IMobileWidget> Widgets { get; }
- IDataAction CreateDataAction(string name = null, IKey key = null)
- IOnSyncCompleteEvent CreateOnSyncComplete()
- IOnSyncErrorEvent CreateOnSyncError()
- IOnSyncStartEvent CreateOnSyncStart()
- IScreenAction CreateScreenAction(string name = null, IKey key = null)
- IScreenAggregate CreateScreenAggregate(bool isClientSide, string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)
- void SetTitle(ExpressionDefinition value)

### interface IMobileScreenDescriptor : IMobileFlowNodeDescriptor, IMobileScreenSignatureDescriptor, IScreenDescriptor
- IProperty AnonymousAccessProperty { get; }
- IProperty CreatedByAgentProperty { get; }
- IProperty CreatedByToolProperty { get; }
- IProperty CustomURLProperty { get; }
- IChildCollection DataActionsChildCollection { get; }
- IProperty LastModifiedByAgentProperty { get; }
- IProperty LastModifiedByToolProperty { get; }
- IProperty ModifiedByAgentsProperty { get; }
- IProperty ModifiedByToolsProperty { get; }
- IChildCollection OnDestroyChildCollection { get; }
- IChildCollection OnInitializeChildCollection { get; }
- IChildCollection OnReadyChildCollection { get; }
- IChildCollection OnRenderChildCollection { get; }
- IChildCollection OnSyncCompleteChildCollection { get; }
- IChildCollection OnSyncErrorChildCollection { get; }
- IChildCollection OnSyncStartChildCollection { get; }
- IProperty RequiredScriptsProperty { get; }
- IChildCollection ScreenActionsChildCollection { get; }
- IChildCollection ScreenAggregatesChildCollection { get; }
- IProperty TargetsProperty { get; }
- IExpressionProperty TitleProperty { get; }

### interface IMobileScreenSignature : IMobileFlowNodeSignature, IScreenSignature
- IMobileScreenSignatureDescriptor Descriptor { get; }
- string PageName { get; }
- URLStructure URLStructure { get; }

### interface IMobileScreenSignatureDescriptor : IMobileFlowNodeSignatureDescriptor, IScreenSignatureDescriptor
- IProperty PageNameProperty { get; }
- IProperty URLStructureProperty { get; }

### interface IMobileTheme : IMobileThemeSignature, IShareableESpaceObject<IMobileTheme, IMobileThemeSignature>, ITheme
- IMobileThemeSignature BaseTheme { get; set; }
- IMobileThemeDescriptor Descriptor { get; }
- IMobileBlockSignature Footer { get; set; }
- IMobileBlockSignature Header { get; set; }
- string IconLibrary { get; set; }
- IMobileBlockSignature Layout { get; set; }
- IMobileBlockSignature Menu { get; set; }

### interface IMobileThemeDescriptor : IMobileThemeSignatureDescriptor, IThemeDescriptor

### interface IMobileThemeSignature : IThemeSignature
- IMobileThemeSignature BaseTheme { get; }
- IMobileThemeSignatureDescriptor Descriptor { get; }
- IMobileThemeSignature FirstThemeWithGrid { get; }
- IMobileBlockSignature Footer { get; }
- IMobileBlockSignature Header { get; }
- string IconLibrary { get; }
- IMobileBlockSignature Layout { get; }
- IMobileBlockSignature Menu { get; }
- ValueTuple<bool, string, string, Version> IsBasedOnModelPlugin()

### interface IMobileThemeSignatureDescriptor : IThemeSignatureDescriptor
- IProperty IconLibraryProperty { get; }

### interface IPreviousScreen : IObject
- IPreviousScreenDescriptor Descriptor { get; }
- ISequence<IMetadata> Metadata { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)

### interface IPreviousScreenDescriptor : IObjectDescriptor
- IChildCollection MetadataChildCollection { get; }

### interface IScreenAction : IAction
- IScreenActionDescriptor Descriptor { get; }

### interface IScreenActionDescriptor : IActionDescriptor

### interface IScreenAggregate : IAggregate
- IScreenAggregateDescriptor Descriptor { get; }
- DataSourceFetch Fetch { get; set; }
- IUILifeCycleEvent OnAfterFetch { get; }

### interface IScreenAggregateDescriptor : IAggregateDescriptor
- IProperty FetchProperty { get; }
- IChildCollection OnAfterFetchChildCollection { get; }

## OutSystems.Model.UI.Mobile.Events

### interface IBuiltinEvent : IObject
- IEnumerable<IArgument> Arguments { get; }
- ValidationBehavior BuiltInValidations { get; set; }
- IBuiltinEventDescriptor Descriptor { get; }
- IObjectSignature Destination { get; set; }
- ISequence<IInputParameter> InputParameters { get; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- TransitionTypeWithInheritance Transition { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IBuiltinEventDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty BuiltInValidationsProperty { get; }
- IProperty DestinationProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty TransitionProperty { get; }

### interface IEvent : IObject
- IEnumerable<IArgument> Arguments { get; }
- IEventDescriptor Descriptor { get; }
- string Event { get; set; }
- IObject Handler { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IEventDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty EventProperty { get; }
- IProperty HandlerProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface IOnSyncCompleteEvent : ISynchronizationEvent
- IOnSyncCompleteEventDescriptor Descriptor { get; }

### interface IOnSyncCompleteEventDescriptor : ISynchronizationEventDescriptor

### interface IOnSyncErrorEvent : ISynchronizationEvent
- IOnSyncErrorEventDescriptor Descriptor { get; }

### interface IOnSyncErrorEventDescriptor : ISynchronizationEventDescriptor

### interface IOnSyncStartEvent : ISynchronizationEvent
- IOnSyncStartEventDescriptor Descriptor { get; }

### interface IOnSyncStartEventDescriptor : ISynchronizationEventDescriptor

### interface ISynchronizationEvent : IUILifeCycleEvent
- ISynchronizationEventDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)

### interface ISynchronizationEventDescriptor : IUILifeCycleEventDescriptor
- IChildCollection InputParametersChildCollection { get; }

### interface IUILifeCycleEvent : IObject
- IEnumerable<IArgument> Arguments { get; }
- IUILifeCycleEventDescriptor Descriptor { get; }
- IObjectSignature Destination { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IUILifeCycleEventDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DestinationProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

## OutSystems.Model.UI.Mobile.Widgets

### interface IContent : IContentSignature, IMobileWidget
- IContentDescriptor Descriptor { get; }
- IExpressionProperty SourceProperty { get; }
- ISequence<IMobileWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type type, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)

### interface IContentDescriptor : IContentSignatureDescriptor, IMobileWidgetDescriptor
- IProperty SourcePropertyProperty { get; }

### interface IContentSignature : IMobileWidgetSignature
- IContentSignatureDescriptor Descriptor { get; }
- bool IsIterated { get; }
- string Name { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IContentSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty IsIteratedProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IIfBranchWidget : IIfBranchWidgetSignature, IMobileWidget
- IIfBranchWidgetDescriptor Descriptor { get; }
- ISequence<IMobileWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type type, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)

### interface IIfBranchWidgetDescriptor : IIfBranchWidgetSignatureDescriptor, IMobileWidgetDescriptor

### interface IIfBranchWidgetSignature : IMobileWidgetSignature
- IIfBranchWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IIfBranchWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IChildCollection WidgetsChildCollection { get; }

### interface IIfWidget : IIfWidgetSignature, IMobileWidget
- bool Animate { get; set; }
- IIfWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- IIfBranchWidget FalseBranch { get; }
- string Name { get; set; }
- IIfBranchWidget TrueBranch { get; }
- void SetCondition(ExpressionDefinition value)

### interface IIfWidgetDescriptor : IIfWidgetSignatureDescriptor, IMobileWidgetDescriptor
- IProperty AnimateProperty { get; }
- IChildCollection<IIfWidget, IIfBranchWidget> FalseBranchChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IIfWidget, IIfBranchWidget> TrueBranchChildCollection { get; }

### interface IIfWidgetSignature : IMobileWidgetSignature
- IExpression Condition { get; }
- IIfWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- IIfBranchWidgetSignature FalseBranch { get; }
- IIfBranchWidgetSignature TrueBranch { get; }

### interface IIfWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IExpressionProperty ConditionProperty { get; }
- IProperty DesignModeProperty { get; }
- IChildCollection<IIfWidgetSignature, IIfBranchWidgetSignature> FalseBranchChildCollection { get; }
- IChildCollection<IIfWidgetSignature, IIfBranchWidgetSignature> TrueBranchChildCollection { get; }

### interface ILayoutWidgetDescriptor

### interface IMobileBlockInstanceWidget : IMobileBlockInstanceWidgetSignature, IMobileWidget
- IEnumerable<IArgument> Arguments { get; }
- IMobileBlockInstanceWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- IEnumerable<IEventHandler> EventHandlers { get; }
- string Name { get; set; }
- ISequence<IPlaceholderContentWidget> PlaceholdersContent { get; }
- IMobileBlockSignature SourceBlock { get; set; }

### interface IMobileBlockInstanceWidgetDescriptor : IMobileBlockInstanceWidgetSignatureDescriptor, IMobileWidgetDescriptor
- IChildCollection EventHandlersChildCollection { get; }
- IProperty NameProperty { get; }

### interface IMobileBlockInstanceWidgetSignature : IMobileWidgetSignature
- IEnumerable<IArgumentSignature> Arguments { get; }
- IMobileBlockInstanceWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- IEnumerable<IPlaceholderContentWidgetSignature> PlaceholdersContent { get; }
- IMobileBlockSignature SourceBlock { get; }

### interface IMobileBlockInstanceWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DesignModeProperty { get; }
- IChildCollection PlaceholdersContentChildCollection { get; }
- IProperty SourceBlockProperty { get; }

### interface IMobileWidget : IMobileWidgetSignature, IWidget
- IWidgetDefinitionSignature Definition { get; }
- IMobileWidgetDescriptor Descriptor { get; }

### interface IMobileWidgetDescriptor : IMobileWidgetSignatureDescriptor, IWidgetDescriptor

### interface IMobileWidgetSignature : IWidgetSignature
- IMobileWidgetSignatureDescriptor Descriptor { get; }

### interface IMobileWidgetSignatureDescriptor : IWidgetSignatureDescriptor

### interface IPlaceholderContentWidget : IMobileWidget, IPlaceholderContentWidgetSignature
- IPlaceholderContentWidgetDescriptor Descriptor { get; }
- ISequence<IMobileWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type type, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)

### interface IPlaceholderContentWidgetDescriptor : IMobileWidgetDescriptor, IPlaceholderContentWidgetSignatureDescriptor

### interface IPlaceholderContentWidgetSignature : IMobileWidgetSignature
- IPlaceholderContentWidgetSignatureDescriptor Descriptor { get; }
- IPlaceholderWidgetSignature Placeholder { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }

### interface IPlaceholderContentWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty PlaceholderProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IPlaceholderWidget : IMobileWidget, IPlaceholderWidgetSignature
- Align Align { get; set; }
- AlignItems AlignItems { get; set; }
- AlignSelf AlignSelf { get; set; }
- string ColumnGap { get; set; }
- int? ColumnSpan { get; set; }
- string Description { get; set; }
- IPlaceholderWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IEvent> Events { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string FlexBasis { get; set; }
- FlexDirection FlexDirection { get; set; }
- Flexible Flexible { get; set; }
- FlexWrap FlexWrap { get; set; }
- string Gap { get; set; }
- int? GridColumns { get; set; }
- int? GridRows { get; set; }
- string Height { get; set; }
- JustifyContent JustifyContent { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string RowGap { get; set; }
- int? RowSpan { get; set; }
- WidgetGridType WidgetGridType { get; set; }
- ISequence<IMobileWidget> Widgets { get; }
- string Width { get; set; }
- IEvent CreateEvent()
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IMobileWidget CreateWidget(Type type, string name = null, IKey key = null)
- IMobileWidget CreateWidget(IWidgetDefinitionSignature widgetDefinition, string name = null, IKey key = null)
- void SetStyleClasses(ExpressionDefinition value)

### interface IPlaceholderWidgetDescriptor : IMobileWidgetDescriptor, IPlaceholderWidgetSignatureDescriptor
- IChildCollection EventsChildCollection { get; }

### interface IPlaceholderWidgetSignature : IMobileWidgetSignature
- Align Align { get; }
- AlignItems AlignItems { get; }
- AlignSelf AlignSelf { get; }
- string ColumnGap { get; }
- int? ColumnSpan { get; }
- string Description { get; }
- IPlaceholderWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string FlexBasis { get; }
- FlexDirection FlexDirection { get; }
- Flexible Flexible { get; }
- FlexWrap FlexWrap { get; }
- string Gap { get; }
- int? GridColumns { get; }
- int? GridRows { get; }
- string Height { get; }
- JustifyContent JustifyContent { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string Name { get; }
- string RowGap { get; }
- int? RowSpan { get; }
- IExpression StyleClasses { get; }
- WidgetGridType WidgetGridType { get; }
- IEnumerable<IMobileWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IPlaceholderWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IProperty AlignItemsProperty { get; }
- IProperty AlignProperty { get; }
- IProperty AlignSelfProperty { get; }
- IProperty ColumnGapProperty { get; }
- IProperty ColumnSpanProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty FlexBasisProperty { get; }
- IProperty FlexDirectionProperty { get; }
- IProperty FlexibleProperty { get; }
- IProperty FlexWrapProperty { get; }
- IProperty GapProperty { get; }
- IProperty GridColumnsProperty { get; }
- IProperty GridRowsProperty { get; }
- IProperty HeightProperty { get; }
- IProperty JustifyContentProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty NameProperty { get; }
- IProperty RowGapProperty { get; }
- IProperty RowSpanProperty { get; }
- IExpressionProperty StyleClassesProperty { get; }
- IProperty WidgetGridTypeProperty { get; }
- IChildCollection WidgetsChildCollection { get; }
- IProperty WidthProperty { get; }

### interface ITextWidget : IMobileWidget, ITextWidgetSignature
- ITextWidgetDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Name { get; set; }
- string Text { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetStyleClasses(ExpressionDefinition value)

### interface ITextWidgetDescriptor : IMobileWidgetDescriptor, ITextWidgetSignatureDescriptor
- IProperty NameProperty { get; }

### interface ITextWidgetSignature : IMobileWidgetSignature
- ITextWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression StyleClasses { get; }
- string Text { get; }

### interface ITextWidgetSignatureDescriptor : IMobileWidgetSignatureDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty StyleClassesProperty { get; }
- IProperty TextProperty { get; }

## OutSystems.Model.UI.Web

### interface IComment : IWebFlowNode
- IEnumerable<ICommentConnector> Connectors { get; }
- string CreatedBy { get; set; }
- ICommentDescriptor Descriptor { get; }
- bool IsReminder { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Text { get; set; }
- ICommentConnector CreateConnector(IWebFlowNode target)

### interface ICommentConnector : IWebFlowConnector
- ICommentConnectorDescriptor Descriptor { get; }
- string Label { get; set; }

### interface ICommentConnectorDescriptor : IWebFlowConnectorDescriptor
- IProperty LabelProperty { get; }

### interface ICommentDescriptor : IWebFlowNodeDescriptor
- IProperty CreatedByProperty { get; }
- IProperty IsReminderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty TextProperty { get; }

### interface IEntry : IWebFlowNode
- string Description { get; set; }
- IEntryDescriptor Descriptor { get; }
- bool IsDefault { get; set; }
- string Name { get; set; }
- IUIFlowNode Target { get; set; }

### interface IEntryDescriptor : IWebFlowNodeDescriptor
- IProperty DescriptionProperty { get; }
- IProperty IsDefaultProperty { get; }
- IProperty NameProperty { get; }
- IProperty TargetProperty { get; }

### interface IExternalSite : IWebFlowNode
- string CreatedBy { get; set; }
- string Description { get; set; }
- IExternalSiteDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- bool IsFrequentDestination { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Name { get; set; }
- string URL { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)

### interface IExternalSiteDescriptor : IWebFlowNodeDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty IsFrequentDestinationProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty NameProperty { get; }
- IProperty URLProperty { get; }

### interface IGoToDestination : IWebFlowNode
- IGoToDestinationDescriptor Descriptor { get; }
- IUIFlowNodeSignature Destination { get; set; }

### interface IGoToDestinationDescriptor : IWebFlowNodeDescriptor
- IProperty DestinationProperty { get; }

### interface IPreparation : IObject
- string CreatedBy { get; set; }
- IPreparationDescriptor Descriptor { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<IActionNode> Nodes { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- bool UserReadOnlySessionsInScreens { get; set; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IPreparationDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty UserReadOnlySessionsInScreensProperty { get; }

### interface IScreenAction : IObject
- string CreatedBy { get; set; }
- string Description { get; set; }
- IScreenActionDescriptor Descriptor { get; }
- ISequence<IInputParameter> InputParameters { get; }
- bool IsCalledByAjax { get; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- ISequence<ILocalVariable> LocalVariables { get; }
- ISequence<IMetadata> Metadata { get; }
- string Name { get; set; }
- IEnumerable<IActionNode> Nodes { get; }
- ISequence<IOutputParameter> OutputParameters { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- bool UserReadOnlySessionsInScreens { get; set; }
- IInputParameter CreateInputParameter(string name = null, IKey key = null)
- ILocalVariable CreateLocalVariable(string name = null, IKey key = null)
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IActionNode CreateNode(Type type, string name = null, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IOutputParameter CreateOutputParameter(string name = null, IKey key = null)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IScreenActionDescriptor : IObjectDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IChildCollection InputParametersChildCollection { get; }
- IProperty IsCalledByAjaxProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IChildCollection LocalVariablesChildCollection { get; }
- IChildCollection MetadataChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection NodesChildCollection { get; }
- IChildCollection OutputParametersChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }
- IProperty UserReadOnlySessionsInScreensProperty { get; }

### interface IWebBlock : IBlock, IShareableESpaceObject<IWebBlock, IWebBlockSignature>, IWebBlockSignature, IWebFlowNode
- int? CacheInMinutes { get; set; }
- IWebBlockDescriptor Descriptor { get; }
- bool HasValidationBehavior { get; set; }
- bool IncludeRuntimeJavaScript { get; set; }
- bool IsNotAjaxSelfRefreshable { get; set; }
- IPreparation Preparation { get; }
- IEnumerable<IScreenAction> ScreenActions { get; }
- ICollection<IUIFlowNode> Targets { get; }
- ISequence<IWebWidget> Widgets { get; }
- IPreparation CreatePreparation()
- IScreenAction CreateScreenAction(string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)

### interface IWebBlockDescriptor : IBlockDescriptor, IWebBlockSignatureDescriptor, IWebFlowNodeDescriptor
- IChildCollection PreparationChildCollection { get; }
- IChildCollection ScreenActionsChildCollection { get; }
- IProperty TargetsProperty { get; }

### interface IWebBlockSignature : IBlockSignature, IWebFlowNodeSignature
- int? CacheInMinutes { get; }
- IWebBlockSignatureDescriptor Descriptor { get; }
- bool HasInputs { get; }
- bool HasNotification { get; }
- bool HasValidationBehavior { get; }
- bool IncludeRuntimeJavaScript { get; }
- bool IsNotAjaxSelfRefreshable { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface IWebBlockSignatureDescriptor : IBlockSignatureDescriptor, IWebFlowNodeSignatureDescriptor
- IProperty CacheInMinutesProperty { get; }
- IProperty HasInputsProperty { get; }
- IProperty HasNotificationProperty { get; }
- IProperty HasValidationBehaviorProperty { get; }
- IProperty IncludeRuntimeJavaScriptProperty { get; }
- IProperty IsNotAjaxSelfRefreshableProperty { get; }

### interface IWebDestination : IObject

### interface IWebEmail : IEmail, IWebFlowNode
- IWebEmailDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IPreparation Preparation { get; }
- ICollection<IUIFlowNode> Targets { get; }
- ISequence<IWebWidget> Widgets { get; }
- IExtendedProperty CreateExtendedProperty()
- IPreparation CreatePreparation()
- T CreateWidget<T>(string name = null, IKey key = null)

### interface IWebEmailDescriptor : IEmailDescriptor, IWebFlowNodeDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IChildCollection PreparationChildCollection { get; }
- IProperty TargetsProperty { get; }

### interface IWebFlow : IShareableESpaceObject<IWebFlow, IWebFlowSignature>, IUIFlow, IWebFlowSignature
- string CreatedBy { get; set; }
- string Description { get; set; }
- IWebFlowDescriptor Descriptor { get; }
- HTTPSecurityWithCertificates HTTPSecurity { get; set; }
- bool IntegratedAuthentication { get; set; }
- bool InternalAccessOnly { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- IEnumerable<IWebFlowNode> Nodes { get; }
- IWebThemeSignature Theme { get; set; }
- IWebBlock CreateBlock(string name = null, IKey key = null)
- IWebEmail CreateEmail(string name = null, IKey key = null)
- T CreateNode<T>(string name = null, IKey key = null)
- IWebScreen CreateScreen(string name = null, IKey key = null)
- IWebScreen Instantiate(IWebScreen templateScreen, IKey newScreenKey = null)
- IEnumerable<IWebScreen> Instantiate(IEnumerable<IWebScreen> templateScreens, IEnumerable<IKey> newScreensKeys = null)

### interface IWebFlowConnector : IUIFlowConnector
- IWebFlowConnectorDescriptor Descriptor { get; }
- IWebFlowNode Source { get; }
- IWebFlowNode Target { get; set; }

### interface IWebFlowConnectorDescriptor : IUIFlowConnectorDescriptor

### interface IWebFlowDescriptor : IUIFlowDescriptor, IWebFlowSignatureDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }

### interface IWebFlowNode : IUIFlowNode, IWebFlowNodeSignature
- IWebFlowNodeDescriptor Descriptor { get; }

### interface IWebFlowNodeDescriptor : IUIFlowNodeDescriptor, IWebFlowNodeSignatureDescriptor

### interface IWebFlowNodeSignature : IUIFlowNodeSignature
- IWebFlowNodeSignatureDescriptor Descriptor { get; }

### interface IWebFlowNodeSignatureDescriptor : IUIFlowNodeSignatureDescriptor

### interface IWebFlowSignature : IUIFlowSignature
- IWebFlowSignatureDescriptor Descriptor { get; }
- HTTPSecurityWithCertificates HTTPSecurity { get; }
- bool IntegratedAuthentication { get; }
- bool InternalAccessOnly { get; }
- IEnumerable<IWebFlowNodeSignature> Nodes { get; }

### interface IWebFlowSignatureDescriptor : IUIFlowSignatureDescriptor
- IProperty HTTPSecurityProperty { get; }
- IProperty IntegratedAuthenticationProperty { get; }
- IProperty InternalAccessOnlyProperty { get; }
- IChildCollection NodesChildCollection { get; }

### interface IWebScreen : IScreen, IShareableESpaceObject<IWebScreen, IWebScreenSignature>, IWebFlowNode, IWebScreenSignature
- int? CacheInMinutes { get; set; }
- IWebScreenDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- HTTPSecurityWithCertificatesAndInheritance HTTPSecurity { get; set; }
- BooleanWithInheritance IntegratedAuthentication { get; set; }
- bool IsFrequentDestination { get; set; }
- string JavaScript { get; set; }
- IPreparation Preparation { get; }
- IEnumerable<IScreenAction> ScreenActions { get; }
- ICollection<IUIFlowNode> Targets { get; }
- IExpression Title { get; }
- ISequence<IWebWidget> Widgets { get; }
- IExtendedProperty CreateExtendedProperty()
- IPreparation CreatePreparation()
- IScreenAction CreateScreenAction(string name = null, IKey key = null)
- T CreateWidget<T>(string name = null, IKey key = null)
- void SetTitle(ExpressionDefinition value)

### interface IWebScreenDescriptor : IScreenDescriptor, IWebFlowNodeDescriptor, IWebScreenSignatureDescriptor
- IProperty CacheInMinutesProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty IntegratedAuthenticationProperty { get; }
- IProperty IsFrequentDestinationProperty { get; }
- IProperty JavaScriptProperty { get; }
- IChildCollection PreparationChildCollection { get; }
- IChildCollection ScreenActionsChildCollection { get; }
- IProperty TargetsProperty { get; }
- IExpressionProperty TitleProperty { get; }

### interface IWebScreenSignature : IScreenSignature, IWebFlowNodeSignature
- IWebScreenSignatureDescriptor Descriptor { get; }
- HTTPSecurityWithCertificatesAndInheritance HTTPSecurity { get; }

### interface IWebScreenSignatureDescriptor : IScreenSignatureDescriptor, IWebFlowNodeSignatureDescriptor
- IProperty HTTPSecurityProperty { get; }

### interface IWebTheme : IShareableESpaceObject<IWebTheme, IWebThemeSignature>, ITheme, IWebThemeSignature
- IWebThemeSignature BaseTheme { get; set; }
- IWebThemeDescriptor Descriptor { get; }
- IWebBlockSignature Email { get; set; }
- IWebFlow ExceptionHandlingFlow { get; set; }
- IImageSignature FalseImage { get; set; }
- IWebBlockSignature Footer { get; set; }
- IWebBlockSignature Header { get; set; }
- IWebBlockSignature InfoBalloon { get; set; }
- IImageSignature InfoBalloonImage { get; set; }
- IWebBlockSignature Layout { get; set; }
- IWebBlockSignature Menu { get; set; }
- bool Mobile { get; set; }
- IOnExceptionAction OnExceptionHandler { get; set; }
- IWebBlockSignature PopUpEditor { get; set; }
- IImageSignature TrueImage { get; set; }

### interface IWebThemeDescriptor : IThemeDescriptor, IWebThemeSignatureDescriptor
- IProperty ExceptionHandlingFlowProperty { get; }

### interface IWebThemeSignature : IThemeSignature
- IWebThemeSignature BaseTheme { get; }
- IWebThemeSignatureDescriptor Descriptor { get; }
- IWebBlockSignature Email { get; }
- IImageSignature FalseImage { get; }
- IWebThemeSignature FirstThemeWithGrid { get; }
- IWebBlockSignature Footer { get; }
- IWebBlockSignature Header { get; }
- IWebBlockSignature InfoBalloon { get; }
- IImageSignature InfoBalloonImage { get; }
- IWebBlockSignature Layout { get; }
- IWebBlockSignature Menu { get; }
- bool Mobile { get; }
- IOnExceptionActionSignature OnExceptionHandler { get; }
- IWebBlockSignature PopUpEditor { get; }
- IImageSignature TrueImage { get; }

### interface IWebThemeSignatureDescriptor : IThemeSignatureDescriptor
- IProperty EmailProperty { get; }
- IProperty FalseImageProperty { get; }
- IProperty InfoBalloonImageProperty { get; }
- IProperty InfoBalloonProperty { get; }
- IProperty MobileProperty { get; }
- IProperty OnExceptionHandlerProperty { get; }
- IProperty PopUpEditorProperty { get; }
- IProperty TrueImageProperty { get; }

## OutSystems.Model.UI.Web.Events

### interface IBuiltinEvent : IObject
- IEnumerable<IArgument> Arguments { get; }
- IBuiltinEventDescriptor Descriptor { get; }
- IObjectSignature Destination { get; set; }
- ISequence<IMetadata> Metadata { get; }
- IEnumerable<ITextResource> TextResources { get; }
- IEnumerable<string> TextResourcesIds { get; }
- T CreateMetadata<T>(string name, string managedBy, IKey key = null)
- void CreateOrUpdateTranslation(Culture culture, string id, string value)
- IEnumerable<string> GetTextResourcesIdsForText(string text)
- void SetTranslationBehavior(string id, TranslationBehavior behavior)

### interface IBuiltinEventDescriptor : IObjectDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DestinationProperty { get; }
- IChildCollection MetadataChildCollection { get; }
- IChildCollection TextResourcesChildCollection { get; }

### interface ILinkOnClick : IBuiltinEvent
- IExpression ConfirmationMessage { get; }
- ILinkOnClickDescriptor Descriptor { get; }
- Method Method { get; set; }
- Validation Validation { get; set; }
- void SetConfirmationMessage(ExpressionDefinition value)

### interface ILinkOnClickDescriptor : IBuiltinEventDescriptor
- IExpressionProperty ConfirmationMessageProperty { get; }
- IProperty MethodProperty { get; }
- IProperty ValidationProperty { get; }

### interface IOnChange : IBuiltinEvent
- IOnChangeDescriptor Descriptor { get; }
- IObject Destination { get; set; }

### interface IOnChangeDescriptor : IBuiltinEventDescriptor

### interface IOnClick : IBuiltinEvent
- IOnClickDescriptor Descriptor { get; }
- IObject Destination { get; set; }

### interface IOnClickDescriptor : IBuiltinEventDescriptor

### interface IOnNotify : IBuiltinEvent
- IOnNotifyDescriptor Descriptor { get; }
- IObject Destination { get; set; }

### interface IOnNotifyDescriptor : IBuiltinEventDescriptor

## OutSystems.Model.UI.Web.Widgets

### interface IButtonWidget : IButtonWidgetSignature, IWebWidget
- IButtonWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- string Example { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- bool IsDefault { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IBuiltinEvent OnClick { get; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetLabel(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IButtonWidgetDescriptor : IButtonWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnClickChildCollection { get; }
- IProperty ValidationParentProperty { get; }

### interface IButtonWidgetSignature : IWebWidgetSignature
- IButtonWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- string Example { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- bool IsDefault { get; }
- IExpression Label { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IButtonWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IProperty ExampleProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty IsDefaultProperty { get; }
- IExpressionProperty LabelProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface ICellWidget : ICellWidgetSignature, IWebWidget
- int? ColumnSpan { get; set; }
- ICellWidgetDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- VerticalAlignment VerticalAlignment { get; set; }
- ISequence<IWebWidget> Widgets { get; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)

### interface ICellWidgetDescriptor : ICellWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }

### interface ICellWidgetSignature : IWebWidgetSignature
- int? ColumnSpan { get; }
- ICellWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- string StyleClasses { get; }
- VerticalAlignment VerticalAlignment { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface ICellWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty ColumnSpanProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty StyleClassesProperty { get; }
- IProperty VerticalAlignmentProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface ICellWidgetWithWidth : ICellWidget, ICellWidgetWithWidthSignature
- ICellWidgetWithWidthDescriptor Descriptor { get; }
- string Width { get; set; }

### interface ICellWidgetWithWidthDescriptor : ICellWidgetDescriptor, ICellWidgetWithWidthSignatureDescriptor

### interface ICellWidgetWithWidthSignature : ICellWidgetSignature
- ICellWidgetWithWidthSignatureDescriptor Descriptor { get; }
- string Width { get; }

### interface ICellWidgetWithWidthSignatureDescriptor : ICellWidgetSignatureDescriptor
- IProperty WidthProperty { get; }

### interface ICheckBoxWidget : ICheckBoxWidgetSignature, IWebWidget
- ICheckBoxWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IOnChange OnChange { get; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- IExpression Variable { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface ICheckBoxWidgetDescriptor : ICheckBoxWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty ValidationParentProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface ICheckBoxWidgetSignature : IWebWidgetSignature
- ICheckBoxWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface ICheckBoxWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface IComboBoxWidget : IWebWidget
- IComboBoxWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExpression IsMandatory { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IOnChange OnChange { get; }
- IEntityAttributeSignature SourceAttribute { get; set; }
- IServerEntitySignature SourceEntity { get; set; }
- IAttributeSignature SourceIdentifierAttribute { get; set; }
- IExpression SourceRecordList { get; }
- ISequence<ISpecialListEntry> SpecialList { get; }
- IExpression SpecialVariable { get; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- IExpression Variable { get; }
- IExpression Visible { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- ISpecialListEntry CreateSpecialList()
- void SetEnabled(ExpressionDefinition value)
- void SetIsMandatory(ExpressionDefinition value)
- void SetSourceRecordList(ExpressionDefinition value)
- void SetSpecialVariable(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IComboBoxWidgetDescriptor : IWebWidgetDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IExpressionProperty EnabledProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty IsMandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty SourceAttributeProperty { get; }
- IProperty SourceEntityProperty { get; }
- IProperty SourceIdentifierAttributeProperty { get; }
- IExpressionProperty SourceRecordListProperty { get; }
- IChildCollection SpecialListChildCollection { get; }
- IVariableProperty SpecialVariableProperty { get; }
- IProperty StyleClassesProperty { get; }
- IProperty ValidationParentProperty { get; }
- IProperty VariableProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface ICommentWidget : IWebWidget
- string CreatedBy { get; set; }
- ICommentWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- bool IsReminder { get; set; }
- string LastMergedBy { get; }
- DateTime LastMergedDate { get; }
- string LastModifiedBy { get; set; }
- DateTime LastModifiedDate { get; set; }
- string Text { get; set; }

### interface ICommentWidgetDescriptor : IWebWidgetDescriptor
- IProperty CreatedByProperty { get; }
- IProperty DesignModeProperty { get; }
- IProperty IsReminderProperty { get; }
- IProperty LastMergedByProperty { get; }
- IProperty LastMergedDateProperty { get; }
- IProperty LastModifiedByProperty { get; }
- IProperty LastModifiedDateProperty { get; }
- IProperty TextProperty { get; }

### interface IContainerWidget : IContainerWidgetSignature, IWebWidget
- Align Align { get; set; }
- IContainerWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IOnClick OnClick { get; }
- string StyleClasses { get; set; }
- ISequence<IWebWidget> Widgets { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)
- void SetDisplay(ExpressionDefinition value)

### interface IContainerWidgetDescriptor : IContainerWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }
- IChildCollection OnClickChildCollection { get; }

### interface IContainerWidgetSignature : IWebWidgetSignature
- Align Align { get; }
- IContainerWidgetSignatureDescriptor Descriptor { get; }
- IExpression Display { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IContainerWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty AlignProperty { get; }
- IExpressionProperty DisplayProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IChildCollection WidgetsChildCollection { get; }
- IProperty WidthProperty { get; }

### interface IContent : IContentSignature, IWebWidget
- IContentDescriptor Descriptor { get; }
- ISequence<IWebWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)

### interface IContentDescriptor : IContentSignatureDescriptor, IWebWidgetDescriptor

### interface IContentSignature : IWebWidgetSignature
- IContentSignatureDescriptor Descriptor { get; }
- string Name { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface IContentSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty NameProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IEditRecordWidget : IEditRecordWidgetSignature, IWebWidget
- string CellHeight { get; set; }
- int? CellSpacing { get; set; }
- IEditRecordWidgetDescriptor Descriptor { get; }
- DisplayColumns DisplayColumns { get; set; }
- EffectiveWidthType EffectiveCaptionWidth { get; set; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveValueWidth { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string LabelStyle { get; set; }
- string LabelWidth { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- IRecordTypeSignature MasterEntity { get; }
- string Name { get; set; }
- IRecordTypeSignature RecordDefinition { get; set; }
- ISequence<IRowWidget> Rows { get; }
- IExpression SourceRecord { get; }
- string StyleClasses { get; set; }
- string ValueStyle { get; set; }
- string VaueWidth { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- IRowWidget CreateRow(string name = null, IKey key = null)
- void SetSourceRecord(ExpressionDefinition value)

### interface IEditRecordWidgetDescriptor : IEditRecordWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty MasterEntityProperty { get; }
- IProperty NameProperty { get; }
- IProperty RecordDefinitionProperty { get; }
- IExpressionProperty SourceRecordProperty { get; }

### interface IEditRecordWidgetSignature : IWebWidgetSignature
- string CellHeight { get; }
- int? CellSpacing { get; }
- IEditRecordWidgetSignatureDescriptor Descriptor { get; }
- DisplayColumns DisplayColumns { get; }
- EffectiveWidthType EffectiveCaptionWidth { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveValueWidth { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string LabelStyle { get; }
- string LabelWidth { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IEnumerable<IRowWidgetSignature> Rows { get; }
- string StyleClasses { get; }
- string ValueStyle { get; }
- string VaueWidth { get; }
- string Width { get; }

### interface IEditRecordWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty CellHeightProperty { get; }
- IProperty CellSpacingProperty { get; }
- IProperty DisplayColumnsProperty { get; }
- IProperty EffectiveCaptionWidthProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveValueWidthProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty LabelStyleProperty { get; }
- IProperty LabelWidthProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IChildCollection RowsChildCollection { get; }
- IProperty StyleClassesProperty { get; }
- IProperty ValueStyleProperty { get; }
- IProperty VaueWidthProperty { get; }
- IProperty WidthProperty { get; }

### interface IExpressionWidget : IExpressionWidgetSignature, IWebWidget
- IExpressionWidgetDescriptor Descriptor { get; }
- bool EscapeContent { get; set; }
- string Example { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetValue(ExpressionDefinition value)

### interface IExpressionWidgetDescriptor : IExpressionWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty EscapeContentProperty { get; }
- IProperty NameProperty { get; }

### interface IExpressionWidgetSignature : IWebWidgetSignature
- IExpressionWidgetSignatureDescriptor Descriptor { get; }
- string Example { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string StyleClasses { get; }
- IExpression Value { get; }

### interface IExpressionWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty ExampleProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty ValueProperty { get; }

### interface IIfBranchWidget : IIfBranchWidgetSignature, IWebWidget
- IIfBranchWidgetDescriptor Descriptor { get; }
- ISequence<IWebWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)

### interface IIfBranchWidgetDescriptor : IIfBranchWidgetSignatureDescriptor, IWebWidgetDescriptor

### interface IIfBranchWidgetSignature : IWebWidgetSignature
- IIfBranchWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface IIfBranchWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection WidgetsChildCollection { get; }

### interface IIfWidget : IIfWidgetSignature, IWebWidget
- IExpression Condition { get; }
- IIfWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- IIfBranchWidget FalseBranch { get; }
- string Name { get; set; }
- IIfBranchWidget TrueBranch { get; }
- void SetCondition(ExpressionDefinition value)

### interface IIfWidgetDescriptor : IIfWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty ConditionProperty { get; }
- IChildCollection<IIfWidget, IIfBranchWidget> FalseBranchChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection<IIfWidget, IIfBranchWidget> TrueBranchChildCollection { get; }

### interface IIfWidgetSignature : IWebWidgetSignature
- IIfWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- IIfBranchWidgetSignature FalseBranch { get; }
- IIfBranchWidgetSignature TrueBranch { get; }

### interface IIfWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty DesignModeProperty { get; }
- IChildCollection<IIfWidgetSignature, IIfBranchWidgetSignature> FalseBranchChildCollection { get; }
- IChildCollection<IIfWidgetSignature, IIfBranchWidgetSignature> TrueBranchChildCollection { get; }

### interface IImageWidget : IImageWidgetSignature, IWebWidget
- IEntityAttributeSignature Attribute { get; set; }
- ImageCache Cache { get; set; }
- IImageWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression EntityIdentifier { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IExpression Filename { get; }
- IImageSignature Image { get; set; }
- IExpression Label { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- ImageType Type { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEntityIdentifier(ExpressionDefinition value)
- void SetFilename(ExpressionDefinition value)
- void SetHeight(ExpressionDefinition value)
- void SetLabel(ExpressionDefinition value)
- void SetURL(ExpressionDefinition value)
- void SetWidth(ExpressionDefinition value)

### interface IImageWidgetDescriptor : IImageWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty AttributeProperty { get; }
- IProperty CacheProperty { get; }
- IExpressionProperty EntityIdentifierProperty { get; }
- IExpressionProperty FilenameProperty { get; }
- IExpressionProperty LabelProperty { get; }
- IProperty NameProperty { get; }

### interface IImageWidgetSignature : IWebWidgetSignature
- IImageWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression Height { get; }
- IImageSignature Image { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- ImageType Type { get; }
- IExpression URL { get; }
- IExpression Width { get; }

### interface IImageWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty HeightProperty { get; }
- IProperty ImageProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IProperty TypeProperty { get; }
- IExpressionProperty URLProperty { get; }
- IExpressionProperty WidthProperty { get; }

### interface IInputFilenameWidget : IInputFilenameWidgetSignature, IWebWidget
- IInputFilenameWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IInputFilenameWidgetDescriptor : IInputFilenameWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IProperty ValidationParentProperty { get; }

### interface IInputFilenameWidgetSignature : IWebWidgetSignature
- IInputFilenameWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IInputFilenameWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface IInputPasswordWidget : IInputPasswordWidgetSignature, IWebWidget
- IInputPasswordWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- int? MaxLength { get; set; }
- string Name { get; set; }
- IOnChange OnChange { get; }
- PasswordType PasswordType { get; set; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- IExpression Variable { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetMandatory(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IInputPasswordWidgetDescriptor : IInputPasswordWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty MaxLengthProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty PasswordTypeProperty { get; }
- IProperty ValidationParentProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface IInputPasswordWidgetSignature : IWebWidgetSignature
- IInputPasswordWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IInputPasswordWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface IInputWidget : IInputWidgetSignature, IWebWidget
- IInputWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- int? MaxLength { get; set; }
- string Name { get; set; }
- IExpression NullValue { get; }
- IOnChange OnChange { get; }
- string StyleClasses { get; set; }
- int? TextLines { get; set; }
- InputType Type { get; set; }
- IObject ValidationParent { get; set; }
- IExpression Variable { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetMandatory(ExpressionDefinition value)
- void SetNullValue(ExpressionDefinition value)
- void SetPrompt(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IInputWidgetDescriptor : IInputWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty MaxLengthProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty NullValueProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty TypeProperty { get; }
- IProperty ValidationParentProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface IInputWidgetSignature : IWebWidgetSignature
- IInputWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression Mandatory { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IExpression Prompt { get; }
- string StyleClasses { get; }
- int? TextLines { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IInputWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty MandatoryProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IExpressionProperty PromptProperty { get; }
- IProperty StyleClassesProperty { get; }
- IProperty TextLinesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface ILinkWidget : ILinkWidgetSignature, IWebWidget
- ILinkWidgetDescriptor Descriptor { get; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- bool IsDefault { get; set; }
- string Name { get; set; }
- ILinkOnClick OnClick { get; }
- string StyleClasses { get; set; }
- IExpression Title { get; }
- IObject ValidationParent { get; set; }
- ISequence<IWebWidget> Widgets { get; }
- IExtendedProperty CreateExtendedProperty()
- ILinkOnClick CreateOnClick()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)
- void SetEnabled(ExpressionDefinition value)
- void SetTitle(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface ILinkWidgetDescriptor : ILinkWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnClickChildCollection { get; }
- IExpressionProperty TitleProperty { get; }
- IProperty ValidationParentProperty { get; }

### interface ILinkWidgetSignature : IWebWidgetSignature
- ILinkWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- bool IsDefault { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface ILinkWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty IsDefaultProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IListBoxWidget : IListBoxWidgetSignature, IWebWidget
- IListBoxWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IOnChange OnChange { get; }
- IAttributeSignature SelectionAttribute { get; set; }
- IAttributeSignature SelectionAttributeParent { get; set; }
- ListBoxSelectionMode SelectionMode { get; set; }
- IAttributeSignature SourceAttribute { get; set; }
- IAttributeSignature SourceAttributeParent { get; set; }
- IExpression SourceRecordList { get; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetSourceRecordList(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IListBoxWidgetDescriptor : IListBoxWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty SelectionAttributeParentProperty { get; }
- IProperty SelectionAttributeProperty { get; }
- IProperty SourceAttributeParentProperty { get; }
- IProperty SourceAttributeProperty { get; }
- IExpressionProperty SourceRecordListProperty { get; }
- IProperty ValidationParentProperty { get; }

### interface IListBoxWidgetSignature : IWebWidgetSignature
- IListBoxWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- ListBoxSelectionMode SelectionMode { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IListBoxWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty SelectionModeProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface IListRecordsWidget : IListRecordsWidgetSignature, IWebWidget
- IListRecordsWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- IExpression EmptyMessage { get; }
- string EmptyMessageStyle { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- ListRecordsLineSeparator LineSeparator { get; set; }
- IRecordTypeSignature MasterEntity { get; }
- string Name { get; set; }
- IExpression SourceRecordList { get; }
- IExpression StartIndex { get; }
- string StyleClasses { get; set; }
- IListType Type { get; }
- ISequence<IWebWidget> Widgets { get; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)
- void SetEmptyMessage(ExpressionDefinition value)
- void SetLineCount(ExpressionDefinition value)
- void SetSourceRecordList(ExpressionDefinition value)
- void SetStartIndex(ExpressionDefinition value)

### interface IListRecordsWidgetDescriptor : IListRecordsWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EmptyMessageProperty { get; }
- IProperty EmptyMessageStyleProperty { get; }
- IProperty MasterEntityProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SourceRecordListProperty { get; }
- IExpressionProperty StartIndexProperty { get; }
- IProperty TypeProperty { get; }

### interface IListRecordsWidgetSignature : IWebWidgetSignature
- IListRecordsWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IExpression LineCount { get; }
- ListRecordsLineSeparator LineSeparator { get; }
- string StyleClasses { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface IListRecordsWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty DesignModeProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IExpressionProperty LineCountProperty { get; }
- IProperty LineSeparatorProperty { get; }
- IProperty StyleClassesProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IPlaceholderContentWidget : IPlaceholderContentWidgetSignature, IWebWidget
- IPlaceholderContentWidgetDescriptor Descriptor { get; }
- ISequence<IWebWidget> Widgets { get; }
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)

### interface IPlaceholderContentWidgetDescriptor : IPlaceholderContentWidgetSignatureDescriptor, IWebWidgetDescriptor

### interface IPlaceholderContentWidgetSignature : IWebWidgetSignature
- IPlaceholderContentWidgetSignatureDescriptor Descriptor { get; }
- IPlaceholderWidgetSignature Placeholder { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }

### interface IPlaceholderContentWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty PlaceholderProperty { get; }
- IChildCollection WidgetsChildCollection { get; }

### interface IPlaceholderWidget : IPlaceholderWidgetSignature, IWebWidget
- Align Align { get; set; }
- string Description { get; set; }
- IPlaceholderWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- ISequence<IWebWidget> Widgets { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- T CreateWidget<T>(string name = null, IKey key = null)
- IWebWidget CreateWidget(Type type, string name = null, IKey key = null)

### interface IPlaceholderWidgetDescriptor : IPlaceholderWidgetSignatureDescriptor, IWebWidgetDescriptor

### interface IPlaceholderWidgetSignature : IWebWidgetSignature
- Align Align { get; }
- string Description { get; }
- IPlaceholderWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- bool IsAjaxRefreshed { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string Name { get; }
- string StyleClasses { get; }
- IEnumerable<IWebWidgetSignature> Widgets { get; }
- string Width { get; }

### interface IPlaceholderWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty AlignProperty { get; }
- IProperty DescriptionProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty IsAjaxRefreshedProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty NameProperty { get; }
- IProperty StyleClassesProperty { get; }
- IChildCollection WidgetsChildCollection { get; }
- IProperty WidthProperty { get; }

### interface IRadioButtonWidget : IRadioButtonWidgetSignature, IWebWidget
- IRadioButtonWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression Enabled { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- IOnChange OnChange { get; }
- string StyleClasses { get; set; }
- IObject ValidationParent { get; set; }
- IExpression Value { get; }
- IExpression Variable { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEnabled(ExpressionDefinition value)
- void SetValue(ExpressionDefinition value)
- void SetVariable(ExpressionDefinition value)
- void SetVisible(ExpressionDefinition value)

### interface IRadioButtonWidgetDescriptor : IRadioButtonWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EnabledProperty { get; }
- IProperty NameProperty { get; }
- IChildCollection OnChangeChildCollection { get; }
- IProperty ValidationParentProperty { get; }
- IExpressionProperty ValueProperty { get; }
- IVariableProperty VariableProperty { get; }

### interface IRadioButtonWidgetSignature : IWebWidgetSignature
- IRadioButtonWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string StyleClasses { get; }
- IExpression Visible { get; }
- string Width { get; }

### interface IRadioButtonWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty StyleClassesProperty { get; }
- IExpressionProperty VisibleProperty { get; }
- IProperty WidthProperty { get; }

### interface IRowWidget : IRowWidgetSignature, IWebWidget
- ISequence<ICellWidget> Cells { get; }
- IRowWidgetDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- ICellWidget CreateCellWidget(string name = null, IKey key = null)
- ICellWidgetWithWidth CreateCellWidgetWithWidth(string name = null, IKey key = null)
- IExtendedProperty CreateExtendedProperty()

### interface IRowWidgetDescriptor : IRowWidgetSignatureDescriptor, IWebWidgetDescriptor

### interface IRowWidgetSignature : IWebWidgetSignature
- IEnumerable<ICellWidgetSignature> Cells { get; }
- IRowWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }

### interface IRowWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection CellsChildCollection { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }

### interface IShowRecordWidget : IShowRecordWidgetSignature, IWebWidget
- string CellHeight { get; set; }
- int? CellSpacing { get; set; }
- IShowRecordWidgetDescriptor Descriptor { get; }
- DisplayColumns DisplayColumns { get; set; }
- EffectiveWidthType EffectiveCaptionWidth { get; set; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveValueWidth { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string LabelStyle { get; set; }
- string LabelWidth { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- IRecordTypeSignature MasterEntity { get; }
- string Name { get; set; }
- ISequence<IRowWidget> Rows { get; }
- IExpression SourceRecord { get; }
- string StyleClasses { get; set; }
- IRecordTypeSignature Type { get; }
- string ValueStyle { get; set; }
- string VaueWidth { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- IRowWidget CreateRow(string name = null, IKey key = null)
- void SetSourceRecord(ExpressionDefinition value)

### interface IShowRecordWidgetDescriptor : IShowRecordWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty MasterEntityProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SourceRecordProperty { get; }
- IProperty TypeProperty { get; }

### interface IShowRecordWidgetSignature : IWebWidgetSignature
- string CellHeight { get; }
- int? CellSpacing { get; }
- IShowRecordWidgetSignatureDescriptor Descriptor { get; }
- DisplayColumns DisplayColumns { get; }
- EffectiveWidthType EffectiveCaptionWidth { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveValueWidth { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string LabelStyle { get; }
- string LabelWidth { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IEnumerable<IRowWidgetSignature> Rows { get; }
- string StyleClasses { get; }
- string ValueStyle { get; }
- string VaueWidth { get; }
- string Width { get; }

### interface IShowRecordWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty CellHeightProperty { get; }
- IProperty CellSpacingProperty { get; }
- IProperty DisplayColumnsProperty { get; }
- IProperty EffectiveCaptionWidthProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveValueWidthProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty LabelStyleProperty { get; }
- IProperty LabelWidthProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IChildCollection RowsChildCollection { get; }
- IProperty StyleClassesProperty { get; }
- IProperty ValueStyleProperty { get; }
- IProperty VaueWidthProperty { get; }
- IProperty WidthProperty { get; }

### interface ITableRecordsWidget : ITableRecordsWidgetSignature, IWebWidget
- string CellHeight { get; set; }
- int? CellSpacing { get; set; }
- IRowWidget DataRow { get; }
- ITableRecordsWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- IExpression EmptyMessage { get; }
- string EvenLineStyle { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- IRowWidget HeaderRow { get; }
- string HeaderStyle { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- IRecordTypeSignature MasterEntity { get; }
- string Name { get; set; }
- string OddLineStyle { get; set; }
- bool ShowHeader { get; set; }
- IExpression SourceRecordList { get; }
- IExpression StartIndex { get; }
- string StyleClasses { get; set; }
- IListType Type { get; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- void SetEmptyMessage(ExpressionDefinition value)
- void SetLineCount(ExpressionDefinition value)
- void SetSourceRecordList(ExpressionDefinition value)
- void SetStartIndex(ExpressionDefinition value)

### interface ITableRecordsWidgetDescriptor : ITableRecordsWidgetSignatureDescriptor, IWebWidgetDescriptor
- IExpressionProperty EmptyMessageProperty { get; }
- IProperty MasterEntityProperty { get; }
- IProperty NameProperty { get; }
- IExpressionProperty SourceRecordListProperty { get; }
- IExpressionProperty StartIndexProperty { get; }
- IProperty TypeProperty { get; }

### interface ITableRecordsWidgetSignature : IWebWidgetSignature
- string CellHeight { get; }
- int? CellSpacing { get; }
- IRowWidgetSignature DataRow { get; }
- ITableRecordsWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- string EvenLineStyle { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- IRowWidgetSignature HeaderRow { get; }
- string HeaderStyle { get; }
- IExpression LineCount { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- string OddLineStyle { get; }
- bool ShowHeader { get; }
- string StyleClasses { get; }
- string Width { get; }

### interface ITableRecordsWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty CellHeightProperty { get; }
- IProperty CellSpacingProperty { get; }
- IChildCollection DataRowChildCollection { get; }
- IProperty DesignModeProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IProperty EvenLineStyleProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IChildCollection HeaderRowChildCollection { get; }
- IProperty HeaderStyleProperty { get; }
- IExpressionProperty LineCountProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IProperty OddLineStyleProperty { get; }
- IProperty ShowHeaderProperty { get; }
- IProperty StyleClassesProperty { get; }
- IProperty WidthProperty { get; }

### interface ITableWidget : ITableWidgetSignature, IWebWidget
- Align Align { get; set; }
- string CellHeight { get; set; }
- int? CellSpacing { get; set; }
- ITableWidgetDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; set; }
- EffectiveWidthType EffectiveWidth { get; set; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Height { get; set; }
- string MarginLeft { get; set; }
- string MarginTop { get; set; }
- string Name { get; set; }
- ISequence<IRowWidget> Rows { get; }
- string StyleClasses { get; set; }
- string Width { get; set; }
- IExtendedProperty CreateExtendedProperty()
- IRowWidget CreateRow(string name = null, IKey key = null)

### interface ITableWidgetDescriptor : ITableWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }

### interface ITableWidgetSignature : IWebWidgetSignature
- Align Align { get; }
- string CellHeight { get; }
- int? CellSpacing { get; }
- ITableWidgetSignatureDescriptor Descriptor { get; }
- EffectiveMarginLeftType EffectiveMarginLeft { get; }
- EffectiveWidthType EffectiveWidth { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string Height { get; }
- string MarginLeft { get; }
- string MarginTop { get; }
- IEnumerable<IRowWidgetSignature> Rows { get; }
- string StyleClasses { get; }
- string Width { get; }

### interface ITableWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IProperty AlignProperty { get; }
- IProperty CellHeightProperty { get; }
- IProperty CellSpacingProperty { get; }
- IProperty EffectiveMarginLeftProperty { get; }
- IProperty EffectiveWidthProperty { get; }
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty HeightProperty { get; }
- IProperty MarginLeftProperty { get; }
- IProperty MarginTopProperty { get; }
- IChildCollection RowsChildCollection { get; }
- IProperty StyleClassesProperty { get; }
- IProperty WidthProperty { get; }

### interface ITextWidget : ITextWidgetSignature, IWebWidget
- ITextWidgetDescriptor Descriptor { get; }
- ISequence<IExtendedProperty> ExtendedProperties { get; }
- string Name { get; set; }
- string StyleClasses { get; set; }
- string Text { get; set; }
- IExtendedProperty CreateExtendedProperty()

### interface ITextWidgetDescriptor : ITextWidgetSignatureDescriptor, IWebWidgetDescriptor
- IProperty NameProperty { get; }

### interface ITextWidgetSignature : IWebWidgetSignature
- ITextWidgetSignatureDescriptor Descriptor { get; }
- IEnumerable<IExtendedPropertySignature> ExtendedProperties { get; }
- string StyleClasses { get; }
- string Text { get; }

### interface ITextWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ExtendedPropertiesChildCollection { get; }
- IProperty StyleClassesProperty { get; }
- IProperty TextProperty { get; }

### interface IWebBlockInstanceWidget : IWebBlockInstanceWidgetSignature, IWebWidget
- IEnumerable<IArgument> Arguments { get; }
- IWebBlockInstanceWidgetDescriptor Descriptor { get; }
- DesignMode DesignMode { get; set; }
- IEnumerable<IEventHandler> EventHandlers { get; }
- string Name { get; set; }
- IOnNotify OnNotify { get; }
- ISequence<IPlaceholderContentWidget> PlaceholdersContent { get; }
- IWebBlockSignature SourceBlock { get; set; }
- IObject ValidationParent { get; set; }

### interface IWebBlockInstanceWidgetDescriptor : IWebBlockInstanceWidgetSignatureDescriptor, IWebWidgetDescriptor
- IChildCollection EventHandlersChildCollection { get; }
- IProperty NameProperty { get; }
- IChildCollection OnNotifyChildCollection { get; }
- IProperty ValidationParentProperty { get; }

### interface IWebBlockInstanceWidgetSignature : IWebWidgetSignature
- IEnumerable<IArgumentSignature> Arguments { get; }
- IWebBlockInstanceWidgetSignatureDescriptor Descriptor { get; }
- DesignMode DesignMode { get; }
- IEnumerable<IPlaceholderContentWidgetSignature> PlaceholdersContent { get; }
- IWebBlockSignature SourceBlock { get; }

### interface IWebBlockInstanceWidgetSignatureDescriptor : IWebWidgetSignatureDescriptor
- IChildCollection ArgumentsChildCollection { get; }
- IProperty DesignModeProperty { get; }
- IChildCollection PlaceholdersContentChildCollection { get; }
- IProperty SourceBlockProperty { get; }

### interface IWebWidget : IWebWidgetSignature, IWidget
- IWebWidgetDescriptor Descriptor { get; }

### interface IWebWidgetDescriptor : IWebWidgetSignatureDescriptor, IWidgetDescriptor

### interface IWebWidgetSignature : IWidgetSignature
- IWebWidgetSignatureDescriptor Descriptor { get; }

### interface IWebWidgetSignatureDescriptor : IWidgetSignatureDescriptor

## OutSystems.Model.XRay

### class XRayEncoding

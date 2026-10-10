# OutSystems.Model.Plugin.SOAP (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## ServiceStudio.Plugin.SOAP

### interface ISettings
- void AddRecentUrl(Uri uri)
- void ClearRecentUrls()
- string GetRecentUrls()
- IList<string> GetRecentUrlsList()

### interface ISOAPAction : IConsumedAction
- int? Cache { get; set; }
- ISOAPActionDescriptor Descriptor { get; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- int? TimeoutInSeconds { get; set; }
- string WcfName { get; set; }
- ISOAPActionInput CreateSOAPActionInput(string name = null, IKey key = null)
- ISOAPActionInputPolymorphic CreateSOAPActionInputPolymorphic(string name = null, IKey key = null)
- ISOAPActionInputWildcard CreateSOAPActionInputWildcard(string name = null, IKey key = null)
- ISOAPActionOutput CreateSOAPActionOutput(string name = null, IKey key = null)
- ISOAPActionOutputPolymorphic CreateSOAPActionOutputPolymorphic(string name = null, IKey key = null)
- ISOAPActionOutputWildcard CreateSOAPActionOutputWildcard(string name = null, IKey key = null)
- ISOAPDynamicPasswordInput CreateSOAPDynamicPasswordInput(string name = null, IKey key = null)
- ISOAPDynamicUsernameInput CreateSOAPDynamicUsernameInput(string name = null, IKey key = null)

### interface ISOAPActionDescriptor : IConsumedActionDescriptor
- IProperty CacheProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty TimeoutInSecondsProperty { get; }
- IProperty WcfNameProperty { get; }

### interface ISOAPActionInput : IInputParameter
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- ISOAPActionInputDescriptor Descriptor { get; }
- string FullPath { get; set; }
- InputPlacement InputPlacement { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string Order { get; set; }
- string OriginalDefaultValue { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string OriginalType { get; set; }

### interface ISOAPActionInputDescriptor : IInputParameterDescriptor
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty FullPathProperty { get; }
- IProperty InputPlacementProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OrderProperty { get; }
- IProperty OriginalDefaultValueProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty OriginalTypeProperty { get; }

### interface ISOAPActionInputPolymorphic : IInputParameter
- ISOAPActionInputPolymorphicDescriptor Descriptor { get; }
- InputPlacement InputPlacement { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }

### interface ISOAPActionInputPolymorphicDescriptor : IInputParameterDescriptor
- IProperty InputPlacementProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }

### interface ISOAPActionInputWildcard : IInputParameter
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- ISOAPActionInputWildcardDescriptor Descriptor { get; }
- string FullPath { get; set; }
- InputPlacement InputPlacement { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- string Namespace { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- ProcessContents ProcessContents { get; set; }
- WildcardType WildcardType { get; set; }

### interface ISOAPActionInputWildcardDescriptor : IInputParameterDescriptor
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty FullPathProperty { get; }
- IProperty InputPlacementProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NamespaceProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty ProcessContentsProperty { get; }
- IProperty WildcardTypeProperty { get; }

### interface ISOAPActionOutput : IOutputParameter
- ISOAPActionOutputDescriptor Descriptor { get; }
- string FullPath { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string Order { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string OriginalType { get; set; }
- OutputPlacement OutputPlacement { get; set; }

### interface ISOAPActionOutputDescriptor : IOutputParameterDescriptor
- IProperty FullPathProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OrderProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty OriginalTypeProperty { get; }
- IProperty OutputPlacementProperty { get; }

### interface ISOAPActionOutputPolymorphic : IOutputParameter
- ISOAPActionOutputPolymorphicDescriptor Descriptor { get; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- OutputPlacement OutputPlacement { get; set; }

### interface ISOAPActionOutputPolymorphicDescriptor : IOutputParameterDescriptor
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OutputPlacementProperty { get; }

### interface ISOAPActionOutputWildcard : IOutputParameter
- ISOAPActionOutputWildcardDescriptor Descriptor { get; }
- string FullPath { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- string Namespace { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- OutputPlacement OutputPlacement { get; set; }
- ProcessContents ProcessContents { get; set; }
- WildcardType WildcardType { get; set; }

### interface ISOAPActionOutputWildcardDescriptor : IOutputParameterDescriptor
- IProperty FullPathProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NamespaceProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty OutputPlacementProperty { get; }
- IProperty ProcessContentsProperty { get; }
- IProperty WildcardTypeProperty { get; }

### interface ISOAPCallbackActionFlow : IPluginCallback
- CallbackType CallbackType { get; set; }
- ISOAPCallbackActionFlowDescriptor Descriptor { get; }

### interface ISOAPCallbackActionFlowDescriptor : IPluginCallbackDescriptor
- IProperty CallbackTypeProperty { get; }

### interface ISOAPClient : IClient
- IEnumerable<ISOAPAction> Actions { get; }
- string AuthenticationPassword { get; set; }
- AuthenticationType AuthenticationType { get; set; }
- string AuthenticationUsername { get; set; }
- string Binding { get; set; }
- string Contract { get; set; }
- string DefaultUri { get; set; }
- ISOAPClientDescriptor Descriptor { get; }
- IntegratedAuthentication IntegratedAuthentication { get; set; }
- bool IsDynamicallyAuthenticated { get; set; }
- string MetaData { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string WSDL { get; set; }
- string WSDLLocation { get; set; }
- ISOAPAction CreateAction(string name = null, IKey key = null)
- ISOAPStaticEntity CreateSOAPStaticEntity(string name = null, IKey key = null)
- ISOAPStaticEntityPolymorphic CreateSOAPStaticEntityPolymorphic(string name = null, IKey key = null)
- ISOAPStructure CreateSOAPStructure(string name = null, IKey key = null)
- ISOAPStructurePolymorphic CreateSOAPStructurePolymorphic(string name = null, IKey key = null)

### interface ISOAPClientDescriptor : IClientDescriptor
- IProperty AuthenticationPasswordProperty { get; }
- IProperty AuthenticationTypeProperty { get; }
- IProperty AuthenticationUsernameProperty { get; }
- IProperty BindingProperty { get; }
- IProperty ContractProperty { get; }
- IProperty DefaultUriProperty { get; }
- IProperty IntegratedAuthenticationProperty { get; }
- IProperty IsDynamicallyAuthenticatedProperty { get; }
- IProperty MetaDataProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty WSDLLocationProperty { get; }
- IProperty WSDLProperty { get; }

### interface ISOAPDynamicPasswordInput : IInputParameter
- ISOAPDynamicPasswordInputDescriptor Descriptor { get; }

### interface ISOAPDynamicPasswordInputDescriptor : IInputParameterDescriptor

### interface ISOAPDynamicUsernameInput : IInputParameter
- ISOAPDynamicUsernameInputDescriptor Descriptor { get; }

### interface ISOAPDynamicUsernameInputDescriptor : IInputParameterDescriptor

### interface ISOAPStaticEntity : IStaticEntity
- IEnumerable<ISOAPStaticEntityAttribute> Attributes { get; }
- ISOAPStaticEntityDescriptor Descriptor { get; }
- bool IsAnonymous { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string OriginalType { get; set; }
- string ParentElement { get; set; }
- string XmlKind { get; set; }
- ISOAPStaticEntityAttribute CreateAttribute(string name = null, IKey key = null)

### interface ISOAPStaticEntityAttribute : IEntityAttribute
- ISOAPStaticEntityAttributeDescriptor Descriptor { get; }

### interface ISOAPStaticEntityAttributeDescriptor : IEntityAttributeDescriptor

### interface ISOAPStaticEntityAttributePolymorphic : IEntityAttribute
- ISOAPStaticEntityAttributePolymorphicDescriptor Descriptor { get; }

### interface ISOAPStaticEntityAttributePolymorphicDescriptor : IEntityAttributeDescriptor

### interface ISOAPStaticEntityDescriptor : IStaticEntityDescriptor
- IProperty IsAnonymousProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty OriginalTypeProperty { get; }
- IProperty ParentElementProperty { get; }
- IProperty XmlKindProperty { get; }

### interface ISOAPStaticEntityPolymorphic : IStaticEntity
- IEnumerable<ISOAPStaticEntityAttributePolymorphic> Attributes { get; }
- ISOAPStaticEntityPolymorphicDescriptor Descriptor { get; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string OriginalType { get; set; }
- ISOAPStaticEntityAttributePolymorphic CreateAttribute(string name = null, IKey key = null)

### interface ISOAPStaticEntityPolymorphicDescriptor : IStaticEntityDescriptor
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty OriginalTypeProperty { get; }

### interface ISOAPStructure : IStructure
- IEnumerable<ISOAPStructureAttribute> Attributes { get; }
- ISOAPStructureDescriptor Descriptor { get; }
- bool IsAnonymous { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string ParentElement { get; set; }
- string XmlKind { get; set; }
- ISOAPStructureAttribute CreateAttribute(string name = null, IKey key = null)

### interface ISOAPStructureAttribute : IStructureAttribute
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- ISOAPStructureAttributeDescriptor Descriptor { get; }
- string FullPath { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string Order { get; set; }
- string OriginalDefaultValue { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalType { get; set; }
- string XmlKind { get; set; }

### interface ISOAPStructureAttributeDescriptor : IStructureAttributeDescriptor
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty FullPathProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OrderProperty { get; }
- IProperty OriginalDefaultValueProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalTypeProperty { get; }
- IProperty XmlKindProperty { get; }

### interface ISOAPStructureAttributePolymorphic : IStructureAttribute
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- ISOAPStructureAttributePolymorphicDescriptor Descriptor { get; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDefaultValue { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalType { get; set; }

### interface ISOAPStructureAttributePolymorphicDescriptor : IStructureAttributeDescriptor
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDefaultValueProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalTypeProperty { get; }

### interface ISOAPStructureAttributeWildcard : IStructureAttribute
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- ISOAPStructureAttributeWildcardDescriptor Descriptor { get; }
- string FullPath { get; set; }
- string MaxOccurrencies { get; set; }
- string MinOccurrencies { get; set; }
- string Namespace { get; set; }
- Nillable Nillable { get; set; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- ProcessContents ProcessContents { get; set; }
- WildcardType WildcardType { get; set; }

### interface ISOAPStructureAttributeWildcardDescriptor : IStructureAttributeDescriptor
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty FullPathProperty { get; }
- IProperty MaxOccurrenciesProperty { get; }
- IProperty MinOccurrenciesProperty { get; }
- IProperty NamespaceProperty { get; }
- IProperty NillableProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty ProcessContentsProperty { get; }
- IProperty WildcardTypeProperty { get; }

### interface ISOAPStructureDescriptor : IStructureDescriptor
- IProperty IsAnonymousProperty { get; }
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty ParentElementProperty { get; }
- IProperty XmlKindProperty { get; }

### interface ISOAPStructurePolymorphic : IStructure
- IEnumerable<ISOAPStructureAttributePolymorphic> Attributes { get; }
- ISOAPStructurePolymorphicDescriptor Descriptor { get; }
- string OriginalDescription { get; set; }
- string OriginalName { get; set; }
- string OriginalNamespace { get; set; }
- string XmlKind { get; set; }
- ISOAPStructureAttributePolymorphic CreateAttribute(string name = null, IKey key = null)

### interface ISOAPStructurePolymorphicDescriptor : IStructureDescriptor
- IProperty OriginalDescriptionProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OriginalNamespaceProperty { get; }
- IProperty XmlKindProperty { get; }

### class ModelFeatures : IDiscoverable

### class Settings : ISettings
- void AddRecentUrl(Uri uri)
- void ClearRecentUrls()
- string GetRecentUrls()
- IList<string> GetRecentUrlsList()

### static class SOAPDocumentation

### class SOAPPluginDescriptor : AbstractPluginDescriptor

### static class SOAPUtils
- string GetBuiltInTypeDefaultValue(XmlQualifiedName builtInType)
- string GetOperationNameWithoutInvalidChars(string originalName)
- bool IsBuiltinType(XmlQualifiedName type)
- XmlQualifiedName ToQName(string input)

### static class TraceHelper
- string GetBasicInfo(StackFrame frame, TraceSwitch traceSwitch)
- string GetErrorInfo(StackFrame frame, TraceSwitch traceSwitch, string errorMessage)
- string GetExceptionInfo(Exception ex)
- StackFrame GetFrame(int deepInStack = 1)
- string NoSuccess(StackFrame frame, TraceSwitch traceSwitch)
- string StartSoapOperation(StackFrame frame, TraceSwitch traceSwitch)

## ServiceStudio.Plugin.SOAP.Enumerations

### enum AuthenticationType
- None
- BasicAuthentication

### enum CallbackType
- Unknown
- OnRequest

### enum DefaultValueBehavior
- Send
- DontSend
- SendNil

### enum InputPlacement
- BodyPlacement
- HeaderPlacement

### enum IntegratedAuthentication
- Send
- DontSend

### enum Nillable
- Yes
- No

### enum OutputPlacement
- BodyPlacement
- HeaderPlacement

### enum ProcessContents
- Skip
- Lax
- Strict

### enum WildcardType
- Any

## ServiceStudio.Plugin.SOAP.Exceptions

### class InvalidWsdlException : Exception, ISerializable

### class InvalidWsdlLocationException : Exception, ISerializable

### class NameCollisionException : Exception, ISerializable

### class PlatformServerCommunicationException : Exception, ISerializable

## ServiceStudio.Plugin.SOAP.Model

### class Binding
- string Description { get; set; }
- string Name { get; set; }

### class Method
- string Description { get; set; }
- List<Parameter> InputParameters { get; set; }
- string Name { get; set; }
- List<Parameter> OutputParameters { get; set; }
- Method.MethodState State { get; set; }
- bool ToImport { get; set; }

### class Parameter
- string Name { get; set; }

### class Port
- Binding Binding { get; set; }
- string Description { get; set; }
- string ListenUri { get; set; }
- string Name { get; set; }
- bool ToImport { get; set; }

### class Service
- string Description { get; set; }
- string Name { get; set; }
- List<Port> Ports { get; set; }

## ServiceStudio.Plugin.SOAP.Parser

### class ImportedWSDL
- ICollection<Binding> Bindings { get; set; }
- ICollection<ContractDescription> Contracts { get; set; }
- int ElementsCreationTime { get; set; }
- ICollection<ServiceEndpoint> Endpoints { get; set; }
- ICollection<ImportedWSDL.Error> Errors { get; }
- bool HasErrors { get; }
- bool HasWarnings { get; }
- ICollection<Document> Imports { get; set; }
- string Metadata { get; set; }
- ICollection<Document> Schemas { get; set; }
- Binding SelectedBinding { get; set; }
- ContractDescription SelectedContract { get; set; }
- ServiceEndpoint SelectedEndpoint { get; set; }
- Service SelectedService { get; set; }
- string WSDLLocation { get; set; }
- string WSDLString { get; set; }
- void CheckMethodsToImport(ICustomClient client)
- OperationBinding GetBindingOperation(string operationName)
- void GetDefaultAndNillables(ICustomClient client)
- ImportWsdlMetrics GetImportWsdlMetrics()
- IEnumerable<string> GetMethodNames()
- IEnumerable<Method> GetMethodsToChoose()
- IEnumerable<Service> GetServices()
- TypeKind GetTypeKindFromBuiltinType(XmlQualifiedName type)
- void ImportDependencies(Uri wsdlUri, ServiceDescription serviceDescription, Dictionary<Uri, string> imports, Dictionary<Uri, string> schemas, List<ServiceDefinitionError> errors, TimeSpan? timeout)
- void ImportSchemas(Uri wsdlUri, XmlSchema wsdlSchema, Dictionary<Uri, string> schemas, List<ServiceDefinitionError> errors, TimeSpan? requestTimeout)
- void ImportServiceFilesAndErrors(ServiceFiles serviceFiles, IEnumerable<ServiceDefinitionError> errors, string wsdlLocation)
- bool NeedChooseBindings()
- bool NeedChooseMethods()
- void RemoveUnusedStaticEntities(ICustomClient client)
- void RemoveUnusedStructures(ICustomClient client)
- void SendTelemetryEvent()
- void UpdateFeaturesCompatibilityMapping(Version platformVersion, Version factoryLowestPlatformVersion)
- void UpdateSelection(ICustomClient client)

### class StronglyConnectedComponentsService<T>
- IEnumerable<T> GetStronglyConnectedComponents(IEnumerable<T> allNodes)

## ServiceStudio.Plugin.SOAP.SOAPDevServiceModel

### class Document
- string Content { get; set; }
- string URI { get; set; }

### class DocumentObject
- Document Document { get; set; }

### class ServiceDefinitionError
- string Code { get; set; }
- string Message { get; set; }

### class ServiceFiles
- List<DocumentObject> Imports { get; set; }
- List<DocumentObject> Schemas { get; set; }
- string WSDL { get; set; }
- string GetMetadataSetString()

### class SoapServiceDefinitionRequest

### class SoapServiceDefinitionResponse
- IList<ServiceDefinitionError> Errors { get; set; }
- bool HasErrors { get; }
- ServiceFiles ServiceFiles { get; set; }
- SoapServiceDefinitionResponse CreateFromJson(string jsonText)
- string GetMetadataSetString()

## ServiceStudio.Plugin.SOAP.SOAPTelemetry

### class ImportWsdlMetrics
- int Abstraction { get; set; }
- int Any { get; set; }
- int AnyAtomicType { get; set; }
- int AnyAttribute { get; set; }
- int AnySimpleType { get; set; }
- int AnyType { get; set; }
- int Choice { get; set; }
- int DefaultValuesAttributes { get; set; }
- int ElementsCreationTime { get; set; }
- int Enumerations { get; set; }
- IEnumerable<string> ErrorCodes { get; }
- int ErrorCount { get; }
- IEnumerable<string> ErrorMessages { get; }
- IEnumerable<IntrospectionMessage> Errors { get; set; }
- int Inheritances { get; set; }
- bool IsInvalid { get; }
- bool IsRefresh { get; set; }
- int MultidimensionalArrays { get; set; }
- int NillAttributes { get; set; }
- int NumberOfMethods { get; set; }
- int NumberOfSelectedMethods { get; set; }
- int NumberOfSupportedMethods { get; set; }
- int Recursions { get; set; }
- ImportWsdlResult Result { get; set; }
- string ResultString { get; }
- IEnumerable<string> SecurityConfidentiality { get; set; }
- IEnumerable<string> SecurityIntegrity { get; set; }
- IEnumerable<string> SecurityTokenElements { get; set; }
- int SoapArrays { get; set; }
- int SoapFaults { get; set; }
- SoapVersion SoapSelectedVersion { get; set; }
- SoapVersion SoapVersion { get; set; }
- string SoapVersionSelectedVersionString { get; }
- string SoapVersionString { get; }
- int UnsupportedFeatures { get; set; }
- int UnsupportedFeaturesEE { get; set; }
- int UnsupportedFeaturesPS { get; set; }
- IEnumerable<string> WarningCodes { get; }
- int WarningCount { get; }
- IEnumerable<string> WarningMessages { get; }
- IEnumerable<IntrospectionMessage> Warnings { get; set; }
- bool WsAddressing { get; set; }
- string WSDLUrl { get; set; }
- WsdlVersion WsdlVersion { get; set; }
- string WsdlVersionString { get; }
- ImportWsdlMetrics GetMetricsForInvalidWSDL(string wsdlLocation, bool isRefresh)
- TelemetryParameters GetTelemetryParameters()
- void SendMetrics()
- void SendMetricsOnInvalidWSDL(string wsdlLocation, bool isRefresh)
- void SetErrorsAndWarnings(IEnumerable<IntrospectionMessage> errors, IEnumerable<IntrospectionMessage> warnings)

### enum ImportWsdlResult
- Success
- SuccessWithWarnings
- Failure
- Invalid

### class IntrospectionMessage
- string Code { get; set; }
- string Message { get; set; }
- string ToString()

### enum SoapVersion
- None
- SOAP_1_1
- SOAP_1_2
- Both

### enum WsdlVersion
- None
- WSDL_1_1
- WSDL_2_0

## ServiceStudio.Plugin.SOAP.Traces

### class OSTraceSwitch : TraceSwitch
- void AddSystemDiagnosticsListenerFile(string filepath)
- void SetTraceLevelToVerbose(string[] switchNames)

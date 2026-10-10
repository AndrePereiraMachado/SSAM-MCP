# OutSystems.Model.Plugin.RESTService (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## ServiceStudio.Plugin.RESTService

### interface IRestService : IService
- IEnumerable<IRestServiceAction> Actions { get; }
- Authentication Authentication { get; set; }
- string BaseURL { get; set; }
- CrossSiteRequests CrossSiteRequests { get; set; }
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- IRestServiceDescriptor Descriptor { get; }
- HttpSecurity HttpSecurity { get; set; }
- InternalAccess InternalAccess { get; set; }
- Interoperability Interoperability { get; set; }
- IRestServiceCallbackActionFlow OnRequestCallback { get; set; }
- IRestServiceCallbackActionFlow OnResponseCallback { get; set; }
- ShowDocumentation ShowDocumentation { get; set; }
- string URL { get; set; }
- IRestServiceAction CreateAction(string name = null, IKey key = null)
- IRestServiceCallbackActionFlow CreateOnRequestCallback()
- IRestServiceCallbackActionFlow CreateOnResponseCallback()

### interface IRestServiceAction : IExposedAction
- IRestServiceActionDescriptor Descriptor { get; }
- HTTPMethod HTTPMethod { get; set; }
- IEnumerable<IRestServiceActionInput> InputParameters { get; }
- IEnumerable<IRestServiceActionOutput> OutputParameters { get; }
- string URL { get; set; }
- string URLPath { get; set; }
- IRestServiceActionInput CreateInputParameter(string name = null, IKey key = null)
- IRestServiceActionOutput CreateOutputParameter(string name = null, IKey key = null)

### interface IRestServiceActionDescriptor : IExposedActionDescriptor
- IProperty HTTPMethodProperty { get; }
- IProperty URLPathProperty { get; }
- IProperty URLProperty { get; }

### interface IRestServiceActionInput : IInputParameter
- IRestServiceActionInputDescriptor Descriptor { get; }
- IsSensitive IsSensitive { get; set; }
- string ReceiveAs { get; set; }
- ReceiveIn ReceiveIn { get; set; }

### interface IRestServiceActionInputDescriptor : IInputParameterDescriptor
- IProperty IsSensitiveProperty { get; }
- IProperty ReceiveAsProperty { get; }
- IProperty ReceiveInProperty { get; }

### interface IRestServiceActionOutput : IOutputParameter
- IRestServiceActionOutputDescriptor Descriptor { get; }
- IsSensitive IsSensitive { get; set; }
- string SendAs { get; set; }
- SendIn SendIn { get; set; }

### interface IRestServiceActionOutputDescriptor : IOutputParameterDescriptor
- IProperty IsSensitiveProperty { get; }
- IProperty SendAsProperty { get; }
- IProperty SendInProperty { get; }

### interface IRestServiceAuthenticationFlow : IPluginCallback
- AuthenticationCallbackType AuthenticationCallbackType { get; set; }
- IRestServiceAuthenticationFlowDescriptor Descriptor { get; }
- IRestServiceActionInput CreateRestServiceActionInput(string name = null, IKey key = null)
- IRestServiceActionOutput CreateRestServiceActionOutput(string name = null, IKey key = null)
- IRestServiceAuthenticationFlowInput CreateRestServiceAuthenticationFlowInput(string name = null, IKey key = null)
- IRestServiceCallbackActionFlowInput CreateRestServiceCallbackActionFlowInput(string name = null, IKey key = null)
- IRestServiceCallbackActionFlowOutput CreateRestServiceCallbackActionFlowOutput(string name = null, IKey key = null)

### interface IRestServiceAuthenticationFlowDescriptor : IPluginCallbackDescriptor
- IProperty AuthenticationCallbackTypeProperty { get; }

### interface IRestServiceAuthenticationFlowInput : IInputParameter
- IRestServiceAuthenticationFlowInputDescriptor Descriptor { get; }

### interface IRestServiceAuthenticationFlowInputDescriptor : IInputParameterDescriptor

### interface IRestServiceCallbackActionFlow : IPluginCallback
- CallbackType CallbackType { get; set; }
- IRestServiceCallbackActionFlowDescriptor Descriptor { get; }
- IRestServiceActionInput CreateRestServiceActionInput(string name = null, IKey key = null)
- IRestServiceActionOutput CreateRestServiceActionOutput(string name = null, IKey key = null)
- IRestServiceAuthenticationFlowInput CreateRestServiceAuthenticationFlowInput(string name = null, IKey key = null)
- IRestServiceCallbackActionFlowInput CreateRestServiceCallbackActionFlowInput(string name = null, IKey key = null)
- IRestServiceCallbackActionFlowOutput CreateRestServiceCallbackActionFlowOutput(string name = null, IKey key = null)

### interface IRestServiceCallbackActionFlowDescriptor : IPluginCallbackDescriptor
- IProperty CallbackTypeProperty { get; }

### interface IRestServiceCallbackActionFlowInput : IInputParameter
- IRestServiceCallbackActionFlowInputDescriptor Descriptor { get; }

### interface IRestServiceCallbackActionFlowInputDescriptor : IInputParameterDescriptor

### interface IRestServiceCallbackActionFlowOutput : IOutputParameter
- IRestServiceCallbackActionFlowOutputDescriptor Descriptor { get; }

### interface IRestServiceCallbackActionFlowOutputDescriptor : IOutputParameterDescriptor

### interface IRestServiceCallbackStructureAttributeDescriptor : IRestServiceCallbackStructureAttributeSignatureDescriptor, IStructureAttributeDescriptor

### interface IRestServiceCallbackStructureAttributeSignature : IStructureAttributeSignature
- IRestServiceCallbackStructureAttributeSignatureDescriptor Descriptor { get; }

### interface IRestServiceCallbackStructureAttributeSignatureDescriptor : IStructureAttributeSignatureDescriptor

### interface IRestServiceCallbackStructureDescriptor : IRestServiceCallbackStructureSignatureDescriptor, IStructureDescriptor

### interface IRestServiceCallbackStructureSignature : IStructureSignature
- IEnumerable<IRestServiceCallbackStructureAttributeSignature> Attributes { get; }
- IRestServiceCallbackStructureSignatureDescriptor Descriptor { get; }

### interface IRestServiceCallbackStructureSignatureDescriptor : IStructureSignatureDescriptor

### interface IRestServiceDescriptor : IServiceDescriptor
- IProperty AuthenticationProperty { get; }
- IProperty BaseURLProperty { get; }
- IProperty CrossSiteRequestsProperty { get; }
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty HttpSecurityProperty { get; }
- IProperty InternalAccessProperty { get; }
- IProperty InteroperabilityProperty { get; }
- IProperty ShowDocumentationProperty { get; }
- IProperty URLProperty { get; }

### class ModelFeatures : IDiscoverable

### class RestServicePluginDescriptor : AbstractPluginDescriptor

## ServiceStudio.Plugin.RESTService.Enumerations

### enum Authentication
- None
- Basic
- Custom

### enum AuthenticationCallbackType
- None
- Custom
- Basic
- OAuth2

### enum CallbackType
- Unknown
- OnRequest
- OnResponse

### enum CrossSiteRequests
- Allow
- Restrict

### enum DefaultValueBehavior
- Send
- DontSend

### enum HTTPMethod
- GET
- PUT
- POST
- DELETE
- PATCH

### enum HttpSecurity
- None
- SSL

### enum InternalAccess
- No
- Yes

### enum Interoperability
- No
- Yes

### enum IsSensitive
- Sensitive
- NotSensitive

### enum ReceiveIn
- URL
- Header
- Body

### enum SendIn
- Body
- Header

### enum ShowDocumentation
- No
- Yes

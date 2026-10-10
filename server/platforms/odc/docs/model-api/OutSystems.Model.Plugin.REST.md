# OutSystems.Model.Plugin.REST (ODC Studio 1.7.25.10778)

Public metadata by reflection; declared members only, inherited members are on the base types listed after the colon.

## OutSystems.ServiceStudio.PluginAPI.Services.RestService

### class DefaultPluginApiRestService : IPluginApiRestService
- HttpResponseMessage Delete(HttpRequestParameters requestParameters)
- HttpResponseMessage Get(HttpRequestParameters requestParameters)
- HttpResponseMessage Patch(HttpRequestParameters requestParameters)
- HttpResponseMessage Post(HttpRequestParameters requestParameters)
- HttpResponseMessage Put(HttpRequestParameters requestParameters)

## ServiceStudio.Plugin.REST

### class Endpoint : IEndpoint
- string Description { get; set; }
- string Url { get; set; }

### interface IEndpoint
- string Description { get; }
- string Url { get; }

### interface IRestAction : IConsumedAction
- string DateFormats { get; set; }
- IRestActionDescriptor Descriptor { get; }
- HTTPMethod HTTPMethod { get; set; }
- IEnumerable<IRestActionInput> InputParameters { get; }
- IEnumerable<IRestActionOutput> OutputParameters { get; }
- RequestFormat RequestFormat { get; set; }
- ResponseFormat ResponseFormat { get; set; }
- string SampleRequest { get; set; }
- string SampleResponse { get; set; }
- int? TimeoutinSeconds { get; set; }
- string URLPath { get; set; }
- IRestActionInput CreateInputParameter(string name = null, IKey key = null)
- IRestActionOutput CreateOutputParameter(string name = null, IKey key = null)

### interface IRestActionDescriptor : IConsumedActionDescriptor
- IProperty DateFormatsProperty { get; }
- IProperty HTTPMethodProperty { get; }
- IProperty RequestFormatProperty { get; }
- IProperty ResponseFormatProperty { get; }
- IProperty SampleRequestProperty { get; }
- IProperty SampleResponseProperty { get; }
- IProperty TimeoutinSecondsProperty { get; }
- IProperty URLPathProperty { get; }

### interface IRestActionInput : IInputParameter
- string ContentType { get; set; }
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- IRestActionInputDescriptor Descriptor { get; }
- InputPlacement InputPlacement { get; set; }
- IsSensitive IsSensitive { get; set; }
- string OriginalName { get; set; }

### interface IRestActionInputDescriptor : IInputParameterDescriptor
- IProperty ContentTypeProperty { get; }
- IProperty DefaultValueBehaviorProperty { get; }
- IProperty InputPlacementProperty { get; }
- IProperty IsSensitiveProperty { get; }
- IProperty OriginalNameProperty { get; }

### interface IRestActionOutput : IOutputParameter
- IRestActionOutputDescriptor Descriptor { get; }
- IsSensitive IsSensitive { get; set; }
- string OriginalName { get; set; }
- OutputPlacement OutputPlacement { get; set; }

### interface IRestActionOutputDescriptor : IOutputParameterDescriptor
- IProperty IsSensitiveProperty { get; }
- IProperty OriginalNameProperty { get; }
- IProperty OutputPlacementProperty { get; }

### interface IRestCallbackActionFlow : IPluginCallback
- CallbackType CallbackType { get; set; }
- IRestCallbackActionFlowDescriptor Descriptor { get; }
- IEnumerable<IRestCallbackActionFlowInputSignature> InputParameters { get; }
- IEnumerable<IRestCallbackActionFlowOutputSignature> OutputParameters { get; }

### interface IRestCallbackActionFlowDescriptor : IPluginCallbackDescriptor
- IProperty CallbackTypeProperty { get; }

### interface IRestCallbackActionFlowInputDescriptor : IInputParameterDescriptor, IRestCallbackActionFlowInputSignatureDescriptor

### interface IRestCallbackActionFlowInputSignature : IInputParameterSignature
- IRestCallbackActionFlowInputSignatureDescriptor Descriptor { get; }

### interface IRestCallbackActionFlowInputSignatureDescriptor : IInputParameterSignatureDescriptor

### interface IRestCallbackActionFlowOutputDescriptor : IOutputParameterDescriptor, IRestCallbackActionFlowOutputSignatureDescriptor

### interface IRestCallbackActionFlowOutputSignature : IOutputParameterSignature
- IRestCallbackActionFlowOutputSignatureDescriptor Descriptor { get; }

### interface IRestCallbackActionFlowOutputSignatureDescriptor : IOutputParameterSignatureDescriptor

### interface IRestCallbackStructureAttributeDescriptor : IRestCallbackStructureAttributeSignatureDescriptor, IStructureAttributeDescriptor

### interface IRestCallbackStructureAttributeSignature : IStructureAttributeSignature
- IRestCallbackStructureAttributeSignatureDescriptor Descriptor { get; }

### interface IRestCallbackStructureAttributeSignatureDescriptor : IStructureAttributeSignatureDescriptor

### interface IRestCallbackStructureDescriptor : IRestCallbackStructureSignatureDescriptor, IStructureDescriptor

### interface IRestCallbackStructureSignature : IStructureSignature
- IEnumerable<IRestCallbackStructureAttributeSignature> Attributes { get; }
- IRestCallbackStructureSignatureDescriptor Descriptor { get; }

### interface IRestCallbackStructureSignatureDescriptor : IStructureSignatureDescriptor

### interface IRestClient : IClient
- string AccessTokenURL { get; set; }
- IEnumerable<IRestAction> Actions { get; }
- AuthenticationType AuthenticationType { get; set; }
- string BaseURL { get; set; }
- IEnumerable<IRestCallbackActionFlow> Callbacks { get; }
- ClientAuthentication ClientAuthentication { get; set; }
- string ClientID { get; set; }
- string ClientSecret { get; set; }
- DateFormat DateFormat { get; set; }
- IRestClientDescriptor Descriptor { get; }
- Interoperability Interoperability { get; set; }
- IRestCallbackActionFlow OnAfterResponseCallback { get; set; }
- IRestCallbackActionFlow OnBeforeRequestCallback { get; set; }
- string Password { get; set; }
- string Scopes { get; set; }
- IEnumerable<IRestStaticEntity> StaticEntities { get; }
- string SwaggerDefinitionURL { get; set; }
- string Username { get; set; }
- IRestAction CreateAction(string name = null, IKey key = null)
- IRestCallbackActionFlow CreateOnAfterResponseAdvancedCallback()
- IRestCallbackActionFlow CreateOnAfterResponseCallback()
- IRestCallbackActionFlow CreateOnBeforeRequestAdvancedCallback()
- IRestCallbackActionFlow CreateOnBeforeRequestCallback()
- IRestStaticEntity CreateStaticEntity(string name = null, IKey key = null)
- IRestStructure CreateStructure(string name = null, IKey key = null)

### interface IRestClientDescriptor : IClientDescriptor
- IProperty AccessTokenURLProperty { get; }
- IProperty AuthenticationTypeProperty { get; }
- IProperty BaseURLProperty { get; }
- IProperty ClientAuthenticationProperty { get; }
- IProperty ClientIDProperty { get; }
- IProperty ClientSecretProperty { get; }
- IProperty DateFormatProperty { get; }
- IProperty InteroperabilityProperty { get; }
- IProperty PasswordProperty { get; }
- IProperty ScopesProperty { get; }
- IProperty SwaggerDefinitionURLProperty { get; }
- IProperty UsernameProperty { get; }

### interface IRestMultipartStructureAttributeDescriptor : IRestMultipartStructureAttributeSignatureDescriptor, IStructureAttributeDescriptor

### interface IRestMultipartStructureAttributeSignature : IStructureAttributeSignature
- IRestMultipartStructureAttributeSignatureDescriptor Descriptor { get; }

### interface IRestMultipartStructureAttributeSignatureDescriptor : IStructureAttributeSignatureDescriptor

### interface IRestMultipartStructureDescriptor : IRestMultipartStructureSignatureDescriptor, IStructureDescriptor

### interface IRestMultipartStructureSignature : IStructureSignature
- IEnumerable<IRestMultipartStructureAttributeSignature> Attributes { get; }
- IRestMultipartStructureSignatureDescriptor Descriptor { get; }

### interface IRestMultipartStructureSignatureDescriptor : IStructureSignatureDescriptor

### interface IRestPluginService : IPluginService
- IRestClient CreateRestClientFromSwagger(IESpace eSpace, string swaggerJson, IKey key = null, IPluginApiRestService restServiceOverride = null)
- IRestClient CreateRestClientFromSwagger(IESpace eSpace, string swaggerJson, Uri swaggerUri = null, Dictionary<Uri, string> dependencies = null, IKey key = null, IPluginApiRestService restServiceOverride = null)
- ISwaggerInfo GetSwaggerInfo(IESpace eSpace, string swaggerJson, Uri swaggerUri = null)

### interface IRestStaticEntity : IStaticEntity
- IEnumerable<IRestStaticEntityAttribute> Attributes { get; }
- IRestStaticEntityDescriptor Descriptor { get; }
- IRestStaticEntityAttribute CreateAttribute(string name = null, IKey key = null)

### interface IRestStaticEntityAttribute : IEntityAttribute
- IRestStaticEntityAttributeDescriptor Descriptor { get; }

### interface IRestStaticEntityAttributeDescriptor : IEntityAttributeDescriptor

### interface IRestStaticEntityDescriptor : IStaticEntityDescriptor

### interface IRestStructure : IStructure
- IEnumerable<IRestStructureAttribute> Attributes { get; }
- IRestStructureDescriptor Descriptor { get; }
- IRestStructureAttribute CreateAttribute(string name = null, IKey key = null)

### interface IRestStructureAttribute : IStructureAttribute
- DefaultValueBehavior DefaultValueBehavior { get; set; }
- IRestStructureAttributeDescriptor Descriptor { get; }

### interface IRestStructureAttributeDescriptor : IStructureAttributeDescriptor
- IProperty DefaultValueBehaviorProperty { get; }

### interface IRestStructureDescriptor : IStructureDescriptor

### interface ISwaggerInfo
- string ApiName { get; }
- Func<IWorkspace, IESpace, ISwaggerInfo, IKey, string, RefreshRest, IRestClient, Tuple<IRestClient, IEnumerable<Warning>>> Create { get; }
- IEnumerable<IEndpoint> Endpoints { get; }
- string ErrorStatus { get; }
- IEnumerable<string> ExternalReferences { get; }
- bool IsValid { get; }
- IEnumerable<RESTMethod> Methods { get; set; }
- AbstractSwaggerParser Parser { get; }

### class ModelFeatures : IDiscoverable

### class Parameter
- string Name { get; set; }

### class RefreshRest
- List<RESTMethod> GetMethodsAfterRefresh()
- void RemoveQueryStringFromUrl(ref string urlPath)

### class RestClientPluginDescriptor : AbstractPluginDescriptor

### static class RestConstants

### class RESTMethod
- string Description { get; set; }
- HTTPMethod HTTPMethod { get; set; }
- string Id { get; set; }
- List<Parameter> InputParameters { get; set; }
- string Name { get; set; }
- List<Parameter> OutputParameters { get; set; }
- string Path { get; set; }
- RESTMethod.MethodState State { get; set; }
- bool ToImport { get; set; }

### class StructureHelper
- ICustomStructureAttribute CreateAttribute(ICustomStructure structure, string name)
- ICustomStructureAttribute CreateAttribute(ICustomStructure structure, ICustomStructureAttribute attr)
- ICustomStructureAttribute CreateAttribute(ICustomStructure structure, string name, string originalName)
- ICustomStructure CreateStructure(string name)
- void DeleteStructure(ICustomStructure structure)
- IEnumerable<ICustomStructure> GetStructures()
- bool IsStructureCompatible(IStructureType from, IStructureType to)
- bool MatchAttributeName(IStructureField attribute1, IStructureField attribute2)
- bool MatchAttributeName(ICustomStructureAttribute attribute1, string name)
- bool MatchStructureName(ICustomStructure structure, string name)
- void SetObjectType(ICustomObjectWithType obj, string suggestedChildStructureName, ParserToken currentToken)
- void UpdateAttributeOriginalName(ICustomStructureAttribute attributeToUpdate, ICustomStructureAttribute attributeWithOriginalName)

### static class StructureHelperExtensions

### class Warning
- bool IsError { get; set; }
- string Message { get; set; }
- string Title { get; set; }

### class Warnings : List<Warning>, ICollection, ICollection<Warning>, IEnumerable, IEnumerable<Warning>, IList, IList<Warning>, IReadOnlyCollection<Warning>, IReadOnlyList<Warning>
- void Add(string title, string message, bool asError)
- void AddError(string title, string message)
- void AddWarning(string title, string message)
- Warnings Empty()

## ServiceStudio.Plugin.REST.Enumerations

### enum AuthenticationType
- None
- BasicAuthentication
- OAuth2

### enum CallbackType
- Unknown
- OnBeforeRequest
- OnBeforeRequestAdvanced
- OnAfterResponse
- OnAfterResponseAdvanced

### enum ClientAuthentication
- SendAsBasicAuthHeader
- SendInBody

### enum DateFormat
- ISO
- UNIXTimestamp
- WCF

### enum DefaultValueBehavior
- Send
- DontSend

### enum HTTPMethod
- GET
- PUT
- POST
- DELETE
- PATCH

### enum InputPlacement
- UrlPlacement
- HeaderPlacement
- BodyPlacement

### enum Interoperability
- No
- Yes

### enum IsSensitive
- Sensitive
- NotSensitive

### enum OutputPlacement
- BodyPlacement
- HeaderPlacement

### enum RequestFormat
- None
- JSON
- Binary
- PlainText
- FormURLEncoded
- MultipartFormat

### enum ResponseFormat
- None
- JSON
- Binary
- PlainText
- MultipartFormat

## ServiceStudio.Plugin.REST.Exceptions

### class InvalidEmptyStructuresException : Exception, ISerializable

### class ParserException : Exception, ISerializable
- string Title { get; set; }

## ServiceStudio.Plugin.REST.ModelDefinition

### class AttributeDefinition

### class ClientDefinition
- string BaseURL { get; }
- string Description { get; }
- IReadOnlyDictionary<string, EnumDefinition> Enums { get; }
- Byte[] Icon { get; }
- IReadOnlyDictionary<string, ListTypeDefinition> ListTypes { get; }
- IEnumerable<MethodDefinition> Methods { get; }
- string Name { get; }
- IReadOnlyDictionary<string, OneOfTypeDefinition> OneOfTypes { get; }
- IReadOnlyDictionary<string, SimpleTypeDefinition> SimpleTypes { get; }
- IReadOnlyDictionary<string, StructureDefinition> Structures { get; }
- string SwaggerURL { get; }
- IReadOnlyDictionary<string, AbstractTypeDefinition> TypeDefinitions { get; }
- void AddMethod(MethodDefinition methodDefinition)
- void AddTopLevelType<T>(string location, T typeDefinition)
- void FilterMethods(IEnumerable<RESTMethod> chosenMethods)
- string ToString()

### class InputDefinition
- string ContentType { get; set; }

### enum InputLocation
- Query
- Path
- Header
- Body
- FormData
- Cookie

### static class InputLocationExtensions
- InputPlacement ToInputPlacement(InputLocation location)

### class MethodDefinition
- string FormURLEncodedRequestSample { get; set; }
- IEnumerable<InputDefinition> Inputs { get; }
- string OtherRequestSample { get; set; }
- IEnumerable<OutputDefinition> Outputs { get; }
- InputDefinition RequestBody { get; }
- RequestFormat RequestFormat { get; set; }
- OutputDefinition ResponseBody { get; }
- ResponseFormat ResponseFormat { get; set; }
- string ResponseSample { get; set; }
- void AddInput(InputDefinition inputDefinition)
- void AddOutput(OutputDefinition outputDefinition)
- string ToString()

### class OutputDefinition

### class ParameterDefinition

## ServiceStudio.Plugin.REST.ModelDefinition.Types

### class AbstractTypeDefinition
- SimpleType? UnderlyingSimpleType { get; }

### class EnumDefinition : AbstractTypeDefinition
- SimpleType? UnderlyingSimpleType { get; }

### class ListTypeDefinition : AbstractTypeDefinition
- AbstractTypeDefinition ElementType { get; set; }
- SimpleType? UnderlyingSimpleType { get; }

### class OneOfTypeDefinition : AbstractTypeDefinition
- IEnumerable<AbstractTypeDefinition> OtherTypes { get; }
- AbstractTypeDefinition SelectedType { get; }
- SimpleType? UnderlyingSimpleType { get; }

### enum SimpleType
- Text
- Integer
- Decimal
- LongInteger
- Boolean
- DateTime
- BinaryData
- Date
- Time

### class SimpleTypeDefinition : AbstractTypeDefinition
- SimpleType? UnderlyingSimpleType { get; }
- bool Equals(object obj)
- SimpleTypeDefinition Get(SimpleType simpleType)
- int GetHashCode()
- string ToString()

### static class SimpleTypeExtensions
- SimpleType ToSimpleType(TypeKind typeKind)
- TypeKind? ToTypeKind(SimpleType simpleType)

### class StructureDefinition : AbstractTypeDefinition
- IEnumerable<AttributeDefinition> Attributes { get; }
- SimpleType? UnderlyingSimpleType { get; }
- void AddAttribute(AttributeDefinition attributeDefinition)
- string ToString()

## ServiceStudio.Plugin.REST.Parser

### class AbstractSwaggerParser
- HashSet<BaseJsonObject> CircularDependencies { get; }
- bool EnumsAreSupported { get; set; }
- IEnumerable<Uri> ExternalRefURIs { get; set; }
- HashSet<Pair<Uri, string>> ExternalSwaggerFiles { get; set; }
- string ImportedSwagger { get; set; }
- bool IsLocalFile { get; }
- HashSet<string> ItemsWithOneOf { get; }
- HashSet<string> ItemsWithTypeArrays { get; }
- bool MultipartIsSupported { get; set; }
- Uri SwaggerDefinitionURI { get; set; }
- string VersionName { get; }
- string VersionNumber { get; }
- Warnings Warnings { get; }
- Uri GetBaseUri()
- IEnumerable<UnparsedAttributeInfo> GetUnparsedAttributesInfo()
- bool IsValid()
- bool IsVersionValid()

### class AbstractSwaggerSchema : BaseJsonObject, IDefinition
- AbstractSwaggerSchema.InfoObject Info { get; }
- bool IsVersionValid()

### class AbstractSwaggerSchemaRecursiveVisitor<S, O, P, R, H>
- void Visit(S schema)
- void Visit(AbstractSwaggerSchema.InfoObject info)
- void Visit(AbstractSwaggerSchema.TypeSchema schema)
- void Visit(O operation)
- void Visit(P parameter)
- void Visit(R response)
- void Visit(H header)
- void Visit(AbstractSwaggerSchema.PathItem<O, P, R, H> pathItem)

### class BaseJsonObject
- string Ref { get; set; }

### interface IDefinition
- bool IsVersionValid()

### class InvalidSwaggerException : Exception, ISerializable

### static class JsonParser
- ParserToken Parse(string json)
- ParserToken Parse(string json, HashSet<JsonParser.DateFormat> dateFormats)
- bool TryParse(string json, HashSet<JsonParser.DateFormat> dateFormats, out ParserToken parsedToken)

### class ParserArray : ParserToken
- ParserToken InnerToken { get; set; }

### class ParserJsonTextReader : JsonTextReader, IAsyncDisposable, IDisposable, IJsonLineInfo
- bool Read()

### class ParserObject : ParserToken
- Dictionary<string, ParserToken> Fields { get; }

### class ParserToken
- string StrValue { get; set; }
- ParserType Type { get; set; }
- string ToString()

### enum ParserType
- Unknown
- Text
- Integer
- LongInteger
- Decimal
- Boolean
- DateTime
- Date
- Time
- BinaryData
- Object
- Array

### static class ParserTypeUtils
- TypeKind ToDataType(ParserType type)

### class SwaggerSchema20 : AbstractSwaggerSchema, IDefinition, ISwaggerSchema<SwaggerSchema20.Operation20, SwaggerSchema20.Parameter20, SwaggerSchema20.Response20, SwaggerSchema20.Header20>
- string BasePath { get; set; }
- SwaggerSchema20.DefinitionsObject Definitions { get; set; }
- string Host { get; set; }
- SwaggerSchema20.ParametersDefinitionsObject Parameters { get; set; }
- AbstractSwaggerSchema.PathsObject<SwaggerSchema20.Operation20, SwaggerSchema20.Parameter20, SwaggerSchema20.Response20, SwaggerSchema20.Header20> Paths { get; set; }
- SwaggerSchema20.ResponsesDefinitionsObject Responses { get; set; }
- IEnumerable<string> Schemes { get; set; }
- string Swagger { get; set; }
- bool IsVersionValid()

### class UnparsedAttributeInfo
- string ToString()

# REST consumido (e exposto) headless no Service Studio 11.55.69 — investigação e plano

Data: 2026-09-04. Alvo: criar, sem UI, uma integração **Consume REST API** (cliente + método GET/POST + URL + headers + parâmetros + structures do JSON) e, resumidamente, uma **Expose REST API**, com o Model API V1 e as classes do Studio carregadas fora da UI (runtime headless do Anvil).

## 0. Resumo executivo

1. **Tudo é criável pelo Model API público + interfaces públicas do plugin REST, sem verbo novo e sem tocar em API interna.** O plugin expõe interfaces públicas tipadas (`IRestClient`, `IRestAction`, `IRestActionInput`, `IRestActionOutput`, `IRestStructure`, `IRestStructureAttribute`, `IRestCallbackActionFlow`) que estendem as do V1 (`IClient`, `IConsumedAction`, `IInputParameter`, `IOutputParameter`, `IStructure`, `IStructureAttribute`, `IPluginCallback`) e acrescentam as propriedades específicas (BaseURL, HTTPMethod, URLPath, InputPlacement...). O ponto de entrada é `IESpace.CreateIntegration<IRestClient>()` — exatamente o que o próprio plugin usa (`ServiceStudio.Plugin.REST.decompiled.cs:6467`).
2. **Provado vivo hoje (headless, `anvil apply`)**: GET com parâmetro de URL e resposta JSON em structure → `isValid=True`, 0 mensagens (blank-service, 25 ops, 587 ms; reactive-ui, 0 mensagens); POST com body JSON, header de método, header de cliente (ExtendedProperty), Basic Auth, output em header → `isValid=True`, 0 mensagens (42 ops); server action que chama o método REST (`IExecuteServerActionNode.Action = IRestAction:GetAddressByCep`, argumento `$call/CEP`) → válido; callback `OnBeforeRequest` criado por `create IRestCallbackActionFlow`; **REST exposto** (`IRestService` + `IRestServiceAction` GET com input em URL e output structure) → `isValid=True`, 0 mensagens.
3. As "ExtendedProperties" do V1 **não** são o mecanismo das propriedades REST. As propriedades do plugin (URL, método, formatos, auth...) são **CustomProperty** filhos do objeto, chaveados pelo `Property.Name` do descritor (ex.: `"Base URL"`, `"URL Path"`, `"HTTPMethod"`, `"InputPlacement"`). `IIntegration.ExtendedProperties` num `IRestClient` são os **HTTP Headers** do cliente (grupo "HTTP Headers", item "Header"/"Value" — `REST.decompiled.cs:4061`).
4. O que o plugin faz a mais na importação (dialog) é **inferir structures a partir do JSON de exemplo** (`JsonParser.TryParse` + `StructureHelper.SetObjectType`, ambos **públicos**) e, no caminho Swagger, `IRestPluginService.CreateRestClientFromSwagger` (público, mas o caminho Swagger 2.0 dereferencia `workspace.RestService` com workspace nulo → NRE; o caminho 3.0 exige feature flag).
5. Plano: (a) usar os verbos existentes (`create`/`set`/`link`) — já funciona; (b) opcional, um verbo composto `rest_client` que só gera as ops e, quando houver `responseJsonSample`, reusa `JsonParser`+`StructureHelper` do plugin para gerar structures; (c) 3 correções pequenas no Anvil (lista de structure via `GetOrCreateListType`, `get` que morre em `PluginNoneType`, seleção do `Create*` por nome quando há vários com o mesmo retorno).

## 1. Fontes (somente leitura)

| Fonte | Caminho |
|---|---|
| Plugin REST (consumo), decompilado por `ilspycmd 9.1` hoje | `C:\Users\andre\AppData\Local\Temp\claude\C--Users-andre-GitSSAM\a4838adf-aeea-4704-8b91-f5f0ca02707d\scratchpad\rest-decomp\ServiceStudio.Plugin.REST\ServiceStudio.Plugin.REST.decompiled.cs` (13 644 linhas; abaixo `REST:`) |
| Plugin RESTService (exposição) | `...\scratchpad\rest-decomp\ServiceStudio.Plugin.RESTService\ServiceStudio.Plugin.RESTService.decompiled.cs` (abaixo `RESTSvc:`) |
| IntegrationPlugins.Utils | `...\scratchpad\rest-decomp\ServiceStudio.IntegrationPlugins.Utils\...decompiled.cs` (só `DefaultValuesUtils`) |
| Model API V1 | `C:\Users\andre\GitSSAM\.ssam\local\native-dll-decompile\source\OutSystems.Model.V1\OutSystems.Model.V1.decompiled.cs` (abaixo `V1:`) |
| Framework do Studio | `...\source\ServiceStudio.Framework\ServiceStudio.Framework.decompiled.cs` (abaixo `FW:`) |
| PluginAPI | `...\source\ServiceStudio.PluginAPI\ServiceStudio.PluginAPI.decompiled.cs` (abaixo `PAPI:`) |
| OML real com 3 REST consumidos | `C:\Users\andre\GitSSAM-lab\.ssam\local\headless\personal-2qqw9srv\Clima_IS.oml` (clientes `OpenMeteoApi`, `ViaCepApi`, `GeoCodingApi`) |
| Produto | `C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs`, `Catalog.cs`, `TypeResolver.cs`, `Adapters.SS11\HeadlessRuntime.cs` |

Nota sobre o OML: o `.oml` de O11 **não é ZIP** (cabeçalho `OML0V\0\0 11.0.0.200|11.55.69.64809|155|<key>|...`; contêiner `OutSystems.Model.Implementation.Oml`, ofuscado). Em vez de abrir o XML, li a representação **como o Model API a devolve** com `anvil apply` (ops `find`/`dump`/`get`, sem mutação) — secção 2.8. Os `Key` devolvidos (`/CustomClients.<k>/CustomActions.<k>/InputParameters.<k>`) são os caminhos de serialização.

## 2. Q1 — Estrutura no modelo de um REST consumido

### 2.1 Como as propriedades REST são guardadas (mecanismo)

- `RestClient : CustomClient`, `RestAction : CustomAction`, `RestActionInput : CustomActionInput`, `RestActionOutput : CustomActionOutput`, `RestStructure : CustomStructure`, `RestStructureAttribute : CustomStructureAttribute`, `RestCallbackActionFlow : CustomCallbackFlow` (`REST:154`, `:2057`, `:2507`, `:3788`, `:5744`, `:5863`, `:2771`). Cada classe declara o `ConcreteClassTagName` que vai ao OML: `"OutSystems.Plugin.REST.RestClient"` (`REST:3794`), `"OutSystems.Plugin.REST.RestAction"` (`:160`), `...RestActionInput` (`:2063`), `...RestActionOutput`, `...RestStructure` (`:5749`), `...RestStructureAttribute` (`:5869`), `...RestCallbackActionFlow` (`:2778`). O tag final é `FormatTagName("CustomClient", ConcreteClassTagName)` (`FW:196801`, `FW:194153`).
- Cada propriedade específica é um `Property` do descritor (`StringProperty`/`EnumProperty<T>`/`IntegerProperty`/`BuiltInProperty`) e o valor vive num filho **`CustomProperty`** (tag `"CustomProperty"`, `FW:73562`) com o **nome do Property**: `Property<T>.GetValue(obj) => obj.GetPropertyValue(base.Name)` / `SetValue => obj.SetPropertyValue(base.Name, value)` (`PAPI:5885-5907`), e `CustomClient.GetPropertyValue` procura `CustomProperties.SingleOrDefault(p => p.Name == propertyName).EffectiveValue` (`FW:196718-196737`). Ao construir o objeto, `OnAfterInit` faz `SynchronizeCustomProperties()` (cria um `CustomProperty` por definição, com o `DefaultValue`) e chama `descriptor.Initialize(obj)` (`FW:196268-196276`, `FW:651815`). Foi isso que o `dump` do Clima_IS mostrou: `"CustomProperty": 312` dos 713 objetos.
- As interfaces públicas do plugin são a superfície tipada dessas CustomProperties (ex.: `IRestClient.BaseURL` ⇄ `RestClientDescriptor.BaseURLProperty` `"Base URL"`, `REST:3807-3816`).

### 2.2 Cliente — `IRestClient : IClient, IIntegration` (`REST:3738-3786`)

Descritor `RestClientDescriptor` (`REST:4060-4062`; GUID `{17E33556-CCF4-4CBF-818D-E117C090E305}`, `DefaultName="RESTAPI"`, `CustomExtendedPropertiesGroup="HTTP Headers"`). Propriedades (`GetBasePropertyDefinitions` em `REST:4248-4262`):

| Propriedade V1/plugin | Chave `CustomProperty` (Property.Name) | Tipo / valores | Default | Fonte |
|---|---|---|---|---|
| `Name`, `Description`, `Icon` (byte[]) | built-in do `IIntegration` | | | `V1:5506-5540` |
| `SwaggerDefinitionURL` | `"SwaggerDefinitionURL"` | string (só p/ Refresh) | "" | `REST:4118` |
| `BaseURL` | `"Base URL"` | string; validada por `^https?://[^?#]+$` | null | `REST:4120`, `:4578` |
| `AuthenticationType` | `"AuthenticationType"` | `None \| BasicAuthentication \| OAuth2` | `None` | `REST:4122`, enums `:13471` |
| `Username`, `Password` | `"Username"`, `"Password"` | string (≤128, obrigatórios se Basic) | null | `REST:4138-4140`, `:4651` |
| `ClientID`, `ClientSecret`, `AccessTokenURL` (https), `Scopes`, `ClientAuthentication` | `"Client ID"`, `"Client Secret"`, `"Access Token URL"`, `"Scopes"`, `"ClientAuthentication"` (`SendAsBasicAuthHeader \| SendInBody`) | OAuth2 (feature `RestConsumeOAuth2`) | | `REST:4142-4150` |
| `DateFormat` | `"DateFormat"` | `ISO \| UNIXTimestamp \| WCF` | `ISO` | `REST:4162` |
| `Interoperability` | `"Interoperability"` | `No \| Yes` (produtor ODC) | `No` | `REST:4178` |
| `OnBeforeRequestCallback`, `OnAfterResponseCallback` | `"OnBeforeRequestCallback"`, `"OnAfterResponseCallback"` (referência a `ICustomActionFlow`) | callback | null | `REST:4200-4206` |
| `ExtendedProperties` (V1 `ISequence<IExtendedProperty>`) | filhos `ExtendedProperty` (`Property`=nome do header, `Value`=expressão) | **HTTP headers do cliente** | | `REST:4061`, `:670`, `:4556-4562` (sugestões `Authorization`, `Accept`, `Accept-Language`, `Content-Type`), `FW:197765` |
| `Actions`, `Structures`, `StaticEntities`, `Callbacks` | coleções filhas (`CustomActions.*`, `CustomStructures.*`, `CustomCallbackFlows.*`) | | | dumps 2.8 |

Criação de filhos pela interface pública do plugin: `CreateAction(name,key)`, `CreateStructure(name,key)`, `CreateStaticEntity(name,key)`, `CreateOnBeforeRequestCallback()`, `CreateOnBeforeRequestAdvancedCallback()`, `CreateOnAfterResponseCallback()`, `CreateOnAfterResponseAdvancedCallback()` (`REST:4017-4045`).

Verify do cliente: erro `"Invalid REST API: <nome> must have at least one method"` se `!client.Actions.Any()` (`REST:4663-4681`); "Base URL" inválida → `"Invalid URL"`; Username/Password vazios com Basic → `"Required Property Value"`.

### 2.3 Método — `IRestAction : IConsumedAction` (`REST:128-152`)

Descritor `RestActionDescriptor` (`REST:338-340`, GUID `{6C6B4C71-...}`, "REST API Method"). Propriedades (`REST:969-981`):

| Propriedade | Chave `CustomProperty` | Tipo / valores | Default | Fonte |
|---|---|---|---|---|
| `URLPath` | `"URL Path"` | string **mandatory**, relativa ao Base URL; `{Param}` obrigatoriamente = input com `InputPlacement=UrlPlacement`; query string vai no próprio path (`/v1/forecast?latitude={Latitude}&...`) | null | `REST:822`, `ValidateUrlPath :1298-1345` |
| `HTTPMethod` | `"HTTPMethod"` | `GET \| PUT \| POST \| DELETE \| PATCH` | `GET` | `REST:824`; GET força `RequestFormat=None` (`:1122`) |
| `RequestFormat` | `"RequestFormat"` | `None(0) \| JSON(1) \| Binary(2) \| PlainText(3) \| FormURLEncoded(4) \| MultipartFormat(5)` | `None` | `REST:848`, enum `:13529` |
| `ResponseFormat` | `"ResponseFormat"` | `None \| JSON \| Binary \| PlainText` | `None` | `REST:881` |
| `TimeoutinSeconds` | `"Timeout in Seconds"` | int? (1..int.Max; runtime usa 100 s se vazio) | null | `REST:1313` |
| `SampleRequest`, `SampleResponse`, `SampleTestValues`, `DateFormats` | `"Sample Request"`, `"Sample Response"`, `"Sample Test Values"`, `"DateFormats"` | strings escondidas (só UI/refresh) | ""/"{ }" | `REST:1314-1317` |
| `CacheInMinutes`, `Description` | built-in do `IConsumedAction` | | | `V1:5544-5582` |
| `ExtendedProperties` | filhos `ExtendedProperty` (existem no `CustomAction`, mas o descritor do método **não** declara grupo de extended properties; headers por método são **inputs** com `HeaderPlacement`) | | | `REST:338` vs `:4061` |

Verify do método (`REST:1188-1296`): `RequestFormat` JSON exige **exatamente um** input com `InputPlacement=BodyPlacement` de tipo Structure/List (`"Required Input Parameter"`); `PlainText`/`Binary` exigem um input Body básico/binário; `FormURLEncoded`/`Multipart` ≥1 input Body (Multipart só com POST); `None` com input Body → `"Invalid Request Format"`; `ResponseFormat` JSON exige exatamente um output Body Structure/List (`"Required Output Parameter"`), `None` com output Body → erro; GET com input Body → `"Invalid HTTP Method"` (`:1289`); `DateFormats` incompatível com `DateFormat` do cliente → erro (`:1721-1750`).

### 2.4 Parâmetros

`IRestActionInput : IInputParameter` (`REST:2045-2056`) — propriedades (`REST:2176-2213`, lista em `:2236`):

| Propriedade | Chave | Valores | Default | Nota |
|---|---|---|---|---|
| `DataType` (V1 `IParameter.DataType`), `IsMandatory`, `DefaultValue`, `Description` | built-in (`"IsMandatory"`, `"DefaultValue"` são `BuiltInProperty`) | | | `V1:1693`, `FW:451547` (setter aceita `AbstractSerializableType`: básicos, structure, list) |
| `InputPlacement` | `"InputPlacement"` | `UrlPlacement \| HeaderPlacement \| BodyPlacement` | `UrlPlacement` | Path e Query são ambos `UrlPlacement` (`InputLocation.ToInputPlacement`, `REST:13068-13085`) |
| `OriginalName` | `"Original Name"` | nome no request (header `X-Api-Key`, campo form) | null | validado por `ValidateHeaderName` (`:1346`) |
| `ContentType` | `"ContentType"` | só Multipart | null | |
| `DefaultValueBehavior` | `"DefaultValueBehavior"` | `Send \| DontSend` | `DontSend` (vira `Send` ao marcar mandatory, `:2338`) | |
| `IsSensitive` | `"IsSensitive"` | `Sensitive \| NotSensitive` | `NotSensitive` | log redaction |

Verify: input `UrlPlacement` cujo nome não aparece como `{nome}` no `URL Path` → `"Unused Input Parameter"` (`REST:2403-2420`); Binary/List/Structure em URL/Header → `"Invalid Data Type"` (`:2361`).

`IRestActionOutput : IOutputParameter` (`REST:2499-2506`; props `:2602-2619`): `OutputPlacement` (`"OutputPlacement"`: `BodyPlacement` default | `HeaderPlacement`), `OriginalName` (`"Original Name"`), `IsSensitive`, mais `DataType`/`DefaultValue` built-in. Header só com tipo básico (`:2697`).

### 2.5 Structures e static entities

- `IRestStructure : IStructure` (`REST:5738-5743`) sem propriedades próprias (`:5819`); filhos criados por `IRestStructure.CreateAttribute(name,key)` (`:5801`, também o V1 `IStructure.CreateAttribute`, `V1:8129-8145`).
- `IRestStructureAttribute : IStructureAttribute` (`REST:5859-5862`) com `DefaultValueBehavior` (`"DefaultValueBehavior"`, default `DontSend`) e built-ins `"IsMandatory"`, `"DefaultValue"`, `"NameInJSON"` (`:5934-5951`). `NameInJSON` é o **nome do campo no JSON** (V1 `IStructureAttribute.NameInJSON`, `V1:8201-8215`); o gerador põe `NameInJSON = attribute.Name` original (`REST:8071`).
- Enums do Swagger viram `IRestStaticEntity` (`REST:5493`, `CommonUtils.CreateStaticEntity`, feature `SwaggerEnums`). Não é preciso para o caso GET/POST simples.
- Structures das callbacks (`HTTPRequest`, `HTTPResponse`, `HTTPHeader`, `URLQueryParameter`) são `IRestCallbackStructure` criadas automaticamente ao criar a callback (`REST:3047-3080`).

### 2.6 Callbacks (`IRestCallbackActionFlow : IPluginCallback`, `REST:2763-2770`)

`CallbackType` (`"CallbackType"`: `OnBeforeRequest | OnBeforeRequestAdvanced | OnAfterResponse | OnAfterResponseAdvanced`, `REST:2907`). `CreateOrReuseOnBeforeRequestFlow` cria o flow, um input `Request` e um output `CustomizedRequest` do tipo `HTTPRequest`, e o cliente aponta para ele por `OnBeforeRequestCallback` (`REST:3092-3105`, `:4032-4045`). Provado vivo: `create parent IRestClient:ViaCepApi type IRestCallbackActionFlow` → flow `OnBeforeRequest` com Start/Assign/End/Comment, 3 structures de callback e `OnBeforeRequestCallback` preenchido (secção 6.2).

### 2.7 Serialização (o que vai para o OML)

Caminhos devolvidos pelo Model API (`Key`), que refletem as coleções serializadas:

```
/CustomClients.5vLP5s2bzEq0lloSnfhIow                                   (RestClient ViaCepApi)
/CustomClients.<k>/CustomActions.Kau6iATlDE2GpQMjDAbjsA                  (RestAction GetAddressByCep)
/CustomClients.<k>/CustomActions.<k>/InputParameters.pJIvjfclfEuOACmvgEeVeg
/CustomClients.<k>/CustomActions.<k>/OutputParameters.7mBYvFed6kGJxNFi6pmuag
/CustomClients.<k>/CustomStructures.IV7kpMBulk+qgRqpdJh2kw/Attributes.NivwPFVGcUWKAw5Fws6VLw
/CustomClients.<k>/ExtendedProperties.mZVT_0fCAEmZoLWWsXfOQQ             (header "Accept")
/CustomClients.<k>/CustomCallbackFlows.pBAw__TCak2E748UFSjTaA             (OnBeforeRequest)
/CustomServices.ZKYfW2XRUUCPO2xVxouFAw/CustomActionFlows.<k>              (REST exposto)
```

Cada objeto leva os `CustomProperty` filhos com `Name` = chave da tabela e `Value`. O plugin é identificado no objeto pelo GUID do descritor (`CustomObjectImplKey`, `FW:194145+`, `PAPI:568 RegisterImplementation`) e pelo tag concreto.

### 2.8 OML real: `Clima_IS.oml` (lido headless, sem alterar)

`find IRestClient` → `OpenMeteoApi`, `ViaCepApi`, `GeoCodingApi`; `find IRestAction` → `GetCurrentClimate`, `GetAddressByCep`, `GetCoordinatesByCityAndUf`; 6 `IRestStructure`; 0 callbacks; 0 extended properties.

`get IRestClient:ViaCepApi` (trecho):
```
"BaseURL": "https://viacep.com.br", "AuthenticationType": "None", "Username": null, "Password": null,
"ClientAuthentication": "SendAsBasicAuthHeader", "DateFormat": "ISO", "Interoperability": "No",
"SwaggerDefinitionURL": null, "OnBeforeRequestCallback": null, "OnAfterResponseCallback": null,
"Structures": 1, "Actions": 1, "ExtendedProperties": 0, "Key": "/CustomClients.5vLP5s2bzEq0lloSnfhIow"
```
`get IRestAction:GetAddressByCep`:
```
"URLPath": "/ws/{CEP}/json/", "HTTPMethod": "GET", "RequestFormat": "None", "ResponseFormat": "JSON",
"TimeoutinSeconds": null, "SampleRequest": null, "SampleResponse": null, "DateFormats": null, "CacheInMinutes": null
```
`get .../#IRestActionInput` (CEP): `"Type": "Text", "IsMandatory": "True", "InputPlacement": "UrlPlacement", "OriginalName": null, "DefaultValueBehavior": "DontSend", "IsSensitive": "NotSensitive"`.
`get .../#IRestActionOutput` (Response): `"DataType": "@IV7kpMBulk+qgRqpdJh2kw"` (= structure `GetAddressByCepResponse`), `"OutputPlacement": "BodyPlacement"`.
`get IRestStructure:GetAddressByCepResponse/#IRestStructureAttribute` (cep): `"NameInJSON": "cep", "Label": "cep", "IsMandatory": "False", "DefaultValueBehavior": "DontSend", "DataType": @Text`.
`get IRestAction:GetCurrentClimate` (query params no path): `"URLPath": "/v1/forecast?latitude={Latitude}&longitude={Longitude}&current=temperature_2m,...&timezone=auto"`, inputs `Latitude`/`Longitude` `Text`, `UrlPlacement`.
O `dump` confirma a classe/assembly de cada objeto: `ServiceStudio.Plugin.REST.RestClient` em `...\Service Studio\Plugins\ServiceStudio\ServiceStudio.Plugin.REST.dll`.

## 3. Q2 — Como o Studio cria ao importar; o que o Verify e o compilador exigem

**Criação na UI** (`RestActionDescriptor.OnBeforeCreate`, `REST:1431-1435`; `RestClientDescriptor.OnBeforeCreate`, `:4717-4721`) abre `ObjectEditor.For<IRestAction>().HandleCreate(...)` (dialog). O dialog alimenta um `UIContext` (`url`, `method`, `request`, `response`, `inputheaders`, `outputheaders`, `basicauth`, `OAuth2`...) e chama `NewActionFromContext` → `parentClient.CreateAction(null, descriptor)` + `UpdateAction` (`REST:1437-1442`, `:1522-1668`), que: separa Base URL do path (regex `.*://[^/]*`), cria inputs `UrlPlacement` para cada `{nome}` do URL (mandatory se antes do `?`), cria inputs/outputs `HeaderPlacement` a partir dos headers escolhidos (`ProcessUIHeaders`, `:1479-1520`), grava `HTTPMethod`/`Sample*`, auth do cliente, e por fim `CreateRequestBasedOnSamples`/`CreateResponseBasedOnSamples` (`:1807`, `:1935`): `JsonParser.TryParse(sample, dateFormats, out token)` decide o formato (Object/Array → JSON; senão PlainText/FormURLEncoded/Multipart), cria o input `Request` (Body) / output `Response` (Body) e chama `new StructureHelper(client).SetObjectType(param, "<Método>Request|Response", token)`, que cria/reusa `IRestStructure`s recursivamente (`:6643-6660`, `:6895-7035`), grava `DateFormats` e ajusta `DateFormat` do cliente.

**Importação Swagger** (`ImportFromSwaggerDefinition`, `REST:5060`; `CreateElementsFromDefinition`, `:5001`): parser 2.0/3.0 → `ClientDefinition`/`MethodDefinition`/`InputDefinition`/`OutputDefinition` (modelo intermédio, `REST:12886-13250`) → `GenerateClientModel` → `OSModelGenerator.GenerateFromIntermediate` (`:7836`), que é a **receita canónica de criação por código**: `SetClientProperties` (Name, Description, `BaseURLProperty`, `SwaggerDefinitionURLProperty`, `AuthenticationTypeProperty`, `AccessTokenURLProperty`, `ScopesProperty`, `Icon`; `:7846`), `CreateTopLevelTypes` (structures com sufixo `Tmp` e depois renomeadas, atributos com `NameInJSONProperty`), `CreateAction` (`:8091-8132`: `CreateAction(name, RestActionDescriptor)`, `HTTPMethodProperty`, `URLPathProperty`, inputs, outputs, `SampleRequestProperty`, `RequestFormatProperty` (PlainText se structure vazia), `SampleResponseProperty`, `ResponseFormatProperty`), `CreateActionInputParameters` (`:8134-8180`: `IsMandatory`, `DefaultValueBehaviorProperty`, `InputPlacementProperty`, `OriginalNameProperty`, query params anexados ao URL Path como `?a={a}&b={b}`, List em query rebaixada a Text), `CreateActionOutputParameters` (`:8177`: `OutputPlacementProperty`, `OriginalNameProperty` só em header, default value via `DefaultValuesUtils`). No fim `RemoveUnusedEmptyStructuresInClient` (`:5222`).

**Verify**: é a soma de (a) `CustomProperty.InnerVerify` — mandatório (`"URL Path"` é o único mandatory do método; `EnumProperty` é sempre mandatory mas tem default) + `Property.ValidateValue` + `descriptor.ValidateProperty` (`FW:74284-74299`); (b) `descriptor.Validate(obj)` chamado de `CustomClient.InnerVerify`/`CustomAction.InnerVerify` (`FW:197822`, `FW:195127`): regras listadas em 2.2-2.4. Não há exigência de `Metadata`/`CreateMetadata<T>` — metadata é opcional (`V1:1763`). Os sample JSON e `DateFormats` também são opcionais (no Clima_IS estão `null` e o módulo é válido).

**Compilador**: não está no decompilado disponível (fica no servidor). O que o modelo grava e o compilador lê são as CustomProperties acima + `NameInJSON` dos atributos + `OriginalName` dos headers + `DefaultValueBehavior`; `ModelFeatures` do plugin (`REST:89-127`) só marcam uso de Multipart/OAuth2/Interoperability (`AddModelFeaturesUsages`, `:309`, `:4052`) e são calculadas no save — nada a fazer para GET/POST JSON.

## 4. Q3 — Dá para fazer tudo pelo Model API público? Que API do plugin é chamável headless?

**Sim, pelo Model API V1 + interfaces públicas do plugin, sem reflexão e sem API interna.** Cadeia:

1. `IESpace.CreateIntegration<IRestClient>(name)` (`V1:480`) → `ModelFactory.Create<T>` (`FW:101786-101789`, `FW:822552`), que só conhece construtores marcados `[ModelAPIConstructor]` descobertos em **todos** os assemblies carregados, plugins incluídos (`ModelAPI.DiscoverTypes(list)` após `PluginProvider.LoadAssemblies`, `FW:2530-2550`; `DiscoverConstructorAndImplementations`, `FW:822684`). `RestClient` tem `[ModelAPIConstructor] internal RestClient(AbstractObject parent, ObjectKey key, string name)` (`REST:4007`), idem `RestAction :299`, `RestActionInput :2162`, `RestActionOutput :2588`, `RestStructure :5791`, `RestStructureAttribute :5920`.
   - Consequência: `CreateIntegration<IClient>` **falha** ("Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IClient") porque `DiscoverModelClasses` remove as interfaces-base de tipos concretos (`FW:822655-822660`); é isso que `docs/mapa/criar-reactive-ui.md` regista para `IClient` (not-allowed). Tem de ser `IRestClient` (ou `IRestService`).
2. Filhos: `IRestClient.CreateAction/CreateStructure/CreateStaticEntity/Create*Callback` (`REST:4017-4045`), `IRestAction.CreateInputParameter/CreateOutputParameter` (`:128-152`, `:318`), `IRestStructure.CreateAttribute` (`:5801`), `IIntegration.CreateExtendedProperty()` + `IExtendedProperty.Property`/`SetValue` (`V1:5536`, `V1:1882-1900`, `FW:197765`).
3. Propriedades: setters tipados nas interfaces do plugin (`IRestClient.BaseURL`, `IRestAction.HTTPMethod`, `IRestActionInput.InputPlacement`...) e V1 (`IParameter.DataType`, `IInputParameter.IsMandatory`, `IStructureAttribute.NameInJSON`).

**Pré-condição headless**: o runtime tem de carregar os plugins (`Runtime` ctor → `PluginProvider.LoadAssemblies` → `TypeLoader.DiscoverTypesInAssembly(assembly, IDiscoverable)` regista os descritores; depois `ModelAPI.DiscoverTypes`, `FW:2530-2550`). O `SsamHeadlessRuntime : Runtime.DummyImplementation` do Anvil (`HeadlessRuntime.cs:73-87`) já faz isso — prova: `inspect Clima_IS.oml` devolve 49 `RestStructureAttribute` e os `dump`s mostram a classe `ServiceStudio.Plugin.REST.RestClient` vinda do DLL de `Plugins\ServiceStudio`. `WorkspaceProvider`/`PluginProvider.GetContext` só entram para OAuth2/Multipart/visibilidade na UI.

**API pública do plugin utilizável headless (além das interfaces do modelo):**

| API | Público? | Headless? | Nota |
|---|---|---|---|
| `JsonParser.TryParse(string json, HashSet<DateFormat>, out ParserToken)` / `JsonParser.Parse` (`REST:12524-12560`) | sim | sim (puro) | inferência de tipos a partir do JSON de exemplo |
| `StructureHelper(ICustomClient)` + `SetObjectType(ICustomObjectWithType obj, string name, ParserToken)` (`REST:6588-6660`) | sim | sim | gera/reusa `IRestStructure`s exatamente como o dialog; `ICustomClient`/`ICustomObjectWithType` são interfaces públicas do PluginAPI implementadas por `RestClient` e por `RestActionInput/Output` (`PAPI:2795`, `:1755`) |
| `RestActionDescriptor.ValidateUrlPath` (`REST:1298`) | sim (static) | sim | pré-validação do URL Path |
| `IRestPluginService.CreateRestClientFromSwagger(IESpace, string swaggerJson, [Uri, deps], IKey)` (`REST:6421-6480`) | sim | **parcial**: caminho 2.0 faz `workspace.RestService` com `workspace == null` (`REST:5007`) → NRE; 3.0 exige feature flag `f5fcaeed-...` e `workspace` para `ChooseRestMethods` | não usar; se se quiser Swagger, montar um `ClientDefinition` e chamar `RestClientDescriptor.GenerateClientModel` (**internal**, exigiria reflexão) |
| `OSModelGenerator`, `RestClientDescriptor.ImportFromSwaggerDefinition`, `UpdateAction`, `CreateRequestBasedOnSamples` | internal/private | — | não chamar; a lógica está reproduzida acima |
| `MockAggregatorPresenter` | — | já usado pelo Anvil em `Publisher.Mutate` (`Publisher.cs:145`) | não é preciso nada extra para REST |

## 5. Q4 — REST exposto (`IRestService` / `IRestServiceAction`), resumido

- `IRestService : IService` (`RESTSvc:91-115`): `BaseURL` (`"Base URL"`, default `/rest/<Nome>`), `URL` (`"URL"` = `/<eSpace>/rest/<Nome>`, ambos recalculados em `Initialize`/rename, `:668-703`), `HttpSecurity` (`None|SSL`, default SSL), `Authentication` (`None=0|Basic=1|Custom=3`), `InternalAccess`, `ShowDocumentation` (Yes), `CrossSiteRequests` (Allow), `DefaultValueBehavior` (DontSend), `Interoperability`; callbacks `OnRequestCallback`/`OnResponseCallback` (`:397-399`) e `IRestServiceAuthenticationFlow` (`:1940`). `CreateAction(name,key)` → `IRestServiceAction` (`:280`). Tag `"OutSystems.Plugin.RESTService.RestService"` (`:121`); GUID `{9F44791A-...}` (`:285`). Verify: precisa de ≥1 método (`:725`).
- `IRestServiceAction : IExposedAction : IAction, IFlow` (`RESTSvc:838-852`) — **é um flow com nós**: `URL` (`"URL"`, calculado `= <URL do serviço>/<URLPath sem />`), `URLPath` (`"URL Path"`, default `/<Nome>`, validado: começa por `/`, chaves casadas, `{param}` tem de existir como input `ReceiveIn=URL`, `:1187-1230`, `:1228`), `HTTPMethod` (`GET` default). Nasce **já com `IStartNode` e `IEndNode`** (dump depois do `create`): criar outro Start dá `InvalidFlow_TooManyNodes`; ligue a partir de `$m/#IStartNode` e para `$m/#IEndNode`.
- Parâmetros: `IRestServiceActionInput` (`ReceiveIn` `URL|Header|Body`, default URL; `ReceiveAs`; `IsSensitive`; `:1370-1377`, `:1483`); só um input Body (`:1660`); GET não pode ter Body (`:1158`). `IRestServiceActionOutput` (`SendIn` `Body|Header`, `SendAs`; `:1670-1677`, `:1781`).
- Prova viva: `IRestService CepService` + `GetCep` (`URLPath /GetCep/{Cep}`, input `Cep` Text `ReceiveIn=URL`, output `Info` = `IStructure CepInfo` do módulo, Assign `Info.Cep = Cep`, links Start→Assign→End, `layout`) → `isValid=True`, 0 mensagens; `URL` calculado `/Headless_CS/rest/CepService/GetCep/{Cep}`. `OnBeforeCreate` do serviço só verifica versão do servidor via `e.Workspace` na UI (`:708`); headless não passa por aí.

## 6. Q5 — Plano de implementação

### 6.1 Sem código novo: ops de verbos (já provado)

Os verbos genéricos do Anvil resolvem tudo porque `Verbs.cs` já (a) aceita interfaces em `ServiceStudio.Plugin.*` (`IsModelApi`, `Verbs.cs:476`), (b) carrega `Plugins/**/ServiceStudio.Plugin.*.dll` ao procurar o tipo (`TypeCandidates`, `:405-429`), (c) casa `CreateIntegration<T>` genérico com `IRestClient` pela restrição `IIntegration` (`FindCreate`, `:435-456`) e Create tipados pelo retorno (`CreateAction`→`IRestAction`, `CreateInputParameter`→`IRestActionInput`, `CreateAttribute`→`IRestStructureAttribute`), (d) converte enums por nome e `DataType` pela mini-linguagem de tipos, inclusive structure por nome (`Convert`, `:500-529`; `TypeResolver.Resolve`, `TypeResolver.cs:15-37`).

Job GET (25 ops, validado em blank-service e reactive-ui; `scratchpad\anvil-out\proof-rest.json`):
```json
{"ops":[
 {"op":"create","parent":"@espace","type":"IRestClient","name":"ViaCepApi","as":"$api"},
 {"op":"set","target":"$api","prop":"BaseURL","value":"https://viacep.com.br"},
 {"op":"create","parent":"$api","type":"IRestStructure","name":"GetAddressByCepResponse","as":"$st"},
 {"op":"create","parent":"$st","type":"IRestStructureAttribute","name":"cep","as":"$a1"},
 {"op":"set","target":"$a1","prop":"DataType","value":"Text"},
 {"op":"set","target":"$a1","prop":"NameInJSON","value":"cep"},
 {"op":"create","parent":"$api","type":"IRestAction","name":"GetAddressByCep","as":"$m"},
 {"op":"set","target":"$m","prop":"HTTPMethod","value":"GET"},
 {"op":"set","target":"$m","prop":"URLPath","value":"/ws/{CEP}/json/"},
 {"op":"set","target":"$m","prop":"ResponseFormat","value":"JSON"},
 {"op":"create","parent":"$m","type":"IRestActionInput","name":"CEP","as":"$in"},
 {"op":"set","target":"$in","prop":"DataType","value":"Text"},
 {"op":"set","target":"$in","prop":"IsMandatory","value":true},
 {"op":"set","target":"$in","prop":"InputPlacement","value":"UrlPlacement"},
 {"op":"create","parent":"$m","type":"IRestActionOutput","name":"Response","as":"$out"},
 {"op":"set","target":"$out","prop":"DataType","value":"GetAddressByCepResponse"},
 {"op":"set","target":"$out","prop":"OutputPlacement","value":"BodyPlacement"}
]}
```
Job POST (`proof-rest-post.json`, 42 ops, válido): idem + `set $api AuthenticationType BasicAuthentication`, `Username`, `Password`; header de cliente `create $api IExtendedProperty as $h` + `set $h Property "Accept"` + `set $h Value "\"application/json\""` (Value é expressão → texto OutSystems entre aspas); método `HTTPMethod POST`, `RequestFormat JSON`, `TimeoutinSeconds 30`; input `Request` `DataType CreateOrderRequest` + `InputPlacement BodyPlacement`; header de método = input `XApiKey` `Text` + `InputPlacement HeaderPlacement` + `OriginalName "X-Api-Key"`; output header `ETag` `Text` + `OutputPlacement HeaderPlacement` + `OriginalName "ETag"`.
Chamada num server action (`proof-rest-call.json`, válido): `create $act IExecuteServerActionNode` + `set Action "IRestAction:GetAddressByCep"` + `set $call/CEP prop Value "Cep"` + Assign `Uf = GetAddressByCep.Response.uf` + links + `layout`.
Callback: `create parent $api type IRestCallbackActionFlow` (cai em `CreateOnBeforeRequestCallback`, o primeiro dos quatro `Create*Callback` com o mesmo retorno) — para escolher o outro tipo é preciso o item 6.3(c).

### 6.2 Verbo composto `rest_client` (opcional, para o agente não escrever 40 ops)

Assinatura proposta (JSON):
```json
{"op":"rest_client","name":"ViaCepApi","baseUrl":"https://viacep.com.br",
 "auth":{"type":"None|BasicAuthentication|OAuth2","username":"","password":""},
 "headers":{"Accept":"\"application/json\""},
 "methods":[{"name":"GetAddressByCep","http":"GET","url":"/ws/{CEP}/json/",
   "inputs":[{"name":"CEP","type":"Text","in":"Url|Header|Body","mandatory":true,"originalName":null}],
   "requestJsonSample":null,"responseJsonSample":"{\"cep\":\"01001-000\",\"uf\":\"SP\",...}",
   "timeout":30}],"as":"$api"}
```
Implementação em `Anvil.Core` (novo `RestClientRecipe`, chamado por `ModelSession.ApplyOne` como os outros verbos): expande para as ops acima **dentro do mesmo comando** (nada de comando por op); quando há `responseJsonSample`/`requestJsonSample`: `JsonParser.TryParse(sample, new HashSet<JsonParser.DateFormat>(), out token)` → `new StructureHelper((ICustomClient)client).SetObjectType((ICustomObjectWithType)param, method.Name + "Response", token)`, que cria as `IRestStructure`s aninhadas e listas com os `NameInJSON` corretos (é o código do Studio, sem cópia); `RequestFormat`/`ResponseFormat` = JSON se `token.Type` for Object/Array, senão PlainText (regra de `REST:1817`, `:1942`). Query params: gerar `?a={a}&b={b}` no URL Path (como `OSModelGenerator.CreateActionInputParameters`, `REST:8145-8180`) e inputs `UrlPlacement` não-mandatórios com `DefaultValueBehavior=DontSend`. Devolver `Summary` do cliente e os handles dos métodos (`$api`, `$api/GetAddressByCep`). Dependência de build: referenciar `ServiceStudio.Plugin.REST.dll` e `ServiceStudio.PluginAPI.dll` da pasta do Studio (já ligada por `StudioAssemblies.Bind`).

### 6.3 Correções pequenas no Anvil (achadas nas provas)

(a) `TypeResolver.Resolve` recusa `"<X> List"` se a lista não existe (`TypeResolver.cs:27-30`); respostas JSON em array exigem `IESpace.GetOrCreateListType(elementType)` (`V1:438`) — acrescentar esse fallback (uma linha). (b) `ModelSession.Get` morre em `IObjectSignature.ObjectKey` de `ServiceStudio.Model.AbstractType.PluginNoneType` (`Verbs.cs:327`) ao ler um `IRestStructure` e o cliente `OpenMeteoApi` — envolver o `ObjectKey` em try/catch. (c) `create` não permite escolher entre vários `Create*` com o mesmo retorno (`CreateOnBeforeRequestCallback` vs `CreateOnAfterResponseCallback` etc., `Verbs.cs:435-456`) — aceitar `"via":"CreateOnAfterResponseCallback"` no op. (d) Catálogo: `Catalog.Extract` só importa interfaces de widgets dos plugins (`Catalog.cs:32-43`); incluir as de `ServiceStudio.Plugin.REST`/`RESTService`/`SOAP`/`SAP` para o agente ver `IRestClient` em `Creatables` (hoje `IClient` aparece como not-allowed e `IRestClient` não aparece).

### 6.4 Validação (roteiro)

1. Headless: `anvil apply --base tests/fixtures/reactive-ui.oml --job proof-rest.json` → `isValid=True`, 0 mensagens (**feito**; também blank-service, POST, chamada em server action, callback, exposto).
2. Merge no Studio aberto (`merge_from_oml`, preview → auto) num módulo de teste e confirmar na árvore Integrations/REST (ícone, propriedades, "Test" do método a funcionar com o CEP `01001000`).
3. Publish (só módulo de teste; ss1) e executar a server action `Cep_Lookup` (1-Click Publish + `prove_action`/HTTP 200); para POST, apontar a um endpoint de eco (ex.: `https://httpbin.org/post`) e verificar `Response`.
4. Negativos a manter como testes: `URLPath` sem `/` → "Invalid URL Path"; `{x}` sem input → "Invalid URL Path"; `RequestFormat=JSON` sem input Body → "Required Input Parameter"; cliente sem métodos → "Invalid REST API".

### 6.5 Riscos

- **Identidade do assembly do plugin**: `TypeCandidates` faz `AssemblyLoadContext.Default.LoadFromAssemblyPath` se ainda não achou o tipo; como o runtime já carregou `ServiceStudio.Plugin.REST.dll` pelo `PluginProvider`, o tipo é o mesmo (provado pelos `dump`s). Se um dia o plugin for carregado num ALC diferente, `CreateIntegration<IRestClient>` vai falhar com "Couldn't find any concrete class implementing".
- **OAuth2/Multipart**: `ModelFeatures.RestConsumeOAuth2.CanBeUsedInServiceStudio(PluginProvider.GetContext(...))` e `WorkspaceProvider.Features` são consultados na UI e no gerador Swagger; via Model API, `set AuthenticationType OAuth2` grava sem consultar, mas o `AddModelFeaturesUsages` marca a feature no save — verificar que o servidor alvo a suporta antes de publicar.
- **Refresh na UI**: sem `SampleRequest`/`SampleResponse` o botão "Open..."/Refresh do Studio mostra o método sem exemplos (não é erro; o Clima_IS também não os tem). Se quisermos paridade total, gravar os samples (`set $m SampleResponse ...`).
- **Estrutura vazia**: `SetObjectType` com JSON `{}` deixa o parâmetro em `TypeKind.None` e o Studio apaga-o e põe `ResponseFormat=None` (`REST:1965`); o verbo deve repetir essa limpeza.
- **Exposto**: `Authentication=Basic/Custom` exige o callback `OnAuthentication` (`IRestServiceAuthenticationFlow`) — fora do escopo desta prova.
- **Publish em Service module**: o REST exposto foi validado num módulo Service (blank-service); em Reactive UI o Verify é o mesmo, mas convém provar no ss1 antes de generalizar.

## 7. Anexo — ficheiros da prova (scratchpad, nada fora dele foi alterado)

`...\scratchpad\anvil-out\`: `find-rest.json` / `dump-rest*.json` / `job-1..5.json` (+ `.out.json`) — leituras do `Clima_IS.oml`; `proof-rest.json` (+ `proof-rest.oml`, `proof-rest-reactive.oml`), `proof-rest-post.json`, `proof-rest-call.json` (base = `proof-rest.oml`), `proof-rest-cb.json`, `proof-rest-expose2.json` (variante válida; `expose3` mostra `RequiredConnector_In` ao criar um End extra, `proof-rest-expose.json` mostra `InvalidFlow_TooManyNodes` ao criar Start extra). Decompilados em `...\scratchpad\rest-decomp\`.

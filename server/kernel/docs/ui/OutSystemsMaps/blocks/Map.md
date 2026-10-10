# Map

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Maps** | publico | 29 widgets internos

Displays an interactive map on your Reactive Web and Native Mobile apps using the Google Maps API. You can change the default behavior of your map using all the options available in the block. 
Use the AddOns blocks (Markers, Shapes and DrawingTools) to customize your map.
To add a list of markers, drag the List widget inside the AddOns placeholder together with the Marker.

For more information, visit https://developers.google.com/maps/documentation/javascript/

Notes: 
- In the same application, we advise using a single map Forge component and a single Google Maps' license. 
- To use DrawingTools, SearchPlaces, or Directions APIs.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| APIKey | Text | nao |  | Add a Google Maps API key to display the map correctly and remove the "development purpose" watermark.  There are 2 ways of setting the API key: - In the input parameter API key (in service studio or from a persistent storage) - In the site property GoogleMapsServerKey in module OutSystemsMaps  To use this feature, your API key must have Geocoding API, Maps JavaScript API and Directions API activated in the console. Keep in mind that if you have a block from OutSystemsMaps and a block from OutSystemsLocations, the API key must be the same or else an error will be returned.   You can get an API key for Google Maps here: https://developers.google.com/maps/documentation/javascript/get-api-key |
| Center | Text | nao | "42.3517926,-71.0467845" | Defines the location of the map. Works with addresses and coordinates (latitude and longitude). If left empty, the default location is the OutSystems Boston office. Please note that the map will automatically adjust to show all markers by default. You can override this by setting Location + Zoom parameters.  On maps with markers, the default location will be the location of the first marker on the list.  GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| Height | Text | nao |  | Set the height of the map in pixels (""300px""), percentage (""100%"") or viewport height (""100vh""). If the value is empty, the map fits to the parent height.  If using percentages, make sure the map has a parent with a fixed height value, otherwise its height will be 0 (zero).  The parameter value is applied to a CSS variable, used in the OutSystems UI Theme. This variable can be overriden to manipulate the map’s height in your CSS theme.   As an example:  .map-container {     height: 500px;     width: 100%; } |
| OptionalConfigs | OptionalMapConfigs | nao |  | Set additional parameters to customize map’s behavior and functionality. |

## Placeholders

- **Events_Placeholder**: Drag-and-drop MapEvent blocks here to listen to map events. (em `content`)
- **AddOns_Placeholder**: Drag-and-drop map addons here to customize your map. You can drag Markers, Shapes and DrawingTools. 
To add a list of markers, drag the List widget inside the AddOns placeholder together with the Marker. (em `content/MapContainer/content/content`)
- **LicenseWarning** (em `content/content`) | nasce com: Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnError**(MapId: Text, ErrorCode: MapErrors Identifier, ErrorMessage: Text): Event triggered when an error occurs in window.
- **Map_Initialized**(MapId: Text): Event triggered when the Map is initialized.

## Composicao interna

- Usa os blocos: ImagesCSS, MapCSS, TerraDrawToolbarCSS
- Scripts exigidos: OutSystemsMaps
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: ObtainMapAPIVersion_OnAfterFetch, SetApiKey, OnParametersChanged, MapOnError_Callback, MapInitialized_Callback, OnDestroy, OnReady, OnInitialize, SubscribeEvents, ObtainMapKey_OnAfterFetch, InitializeProviderMap, UnsubscribeEvents
- Chama actions do modulo: GetGoogleMapsServerKey, GetGoogleMapsVersion, SetProviderVersion, ChangeMapApiKey, ChangeMapUseAdvancedMarkers, ChangeMapZoom, LogEvent, ChangeMapLocation, ChangeMapStyle, SetMapHeight, ChangeMapMarkerClusteringMinClusterSize, ChangeMapLocalization, ChangeMapType, ChangeMapMarkerClusteringActive, ChangeMapAdvancedFormat, ChangeMapMarkerClusteringMaxZoom, ChangeMapStyleId, ChangeMapAutoZoomOnShape, ChangeMapMarkerClusteringZoomOnClick, ChangeMapOffset, ChangeMapRespectUserZoom, ChangeMapRespectUserPosition, ChangeMapShowTraffic, GetMapErrorByErrorCode, RemoveMap, CreateMap, GenerateUniqueId, MapEventSubscribe, InitMap, MapEventUnsubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.MapInitialized_Callback = $actions.MapInitialized_Callback;

$parameters.MapOnError_Callback = $actions.MapOnError_Callback;
```

`UnsubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.MapInitialized_Callback = $actions.MapInitialized_Callback;

$parameters.MapOnError_Callback = $actions.MapOnError_Callback;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Map1","source":"IMobileBlock:Map","empty":true,"as":"$b"}
{"op":"create","parent":"$b/Events_Placeholder","type":"IExpression","as":"$eEvents_Placeholder"}
{"op":"create","parent":"$b/AddOns_Placeholder","type":"IExpression","as":"$eAddOns_Placeholder"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnError` resolve o IEventHandler pelo nome do evento e `$b/OnError/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Map1_OnError","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ErrorCode","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"MapErrors Identifier"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ErrorMessage","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnError","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnError/MapId","prop":"Value","value":"MapId"}
{"op":"set","target":"$b/OnError/ErrorCode","prop":"Value","value":"ErrorCode"}
{"op":"set","target":"$b/OnError/ErrorMessage","prop":"Value","value":"ErrorMessage"}
```

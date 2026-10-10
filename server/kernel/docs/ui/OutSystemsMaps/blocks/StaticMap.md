# StaticMap

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Maps** | publico | 17 widgets internos

Displays non-interactive map on your Reactive Web and Native Mobile apps using the Google Maps API.
To add markers to your map, use the StaticMarkers parameter. 

For more information, visit: https://developers.google.com/maps/documentation/maps-static/start

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| APIKey | Text | nao | "" | Add a Google Maps API key to display the map correctly and remove the "development purpose" watermark.  There are 2 ways of setting the API key: - In the input parameter API key (in service studio or from a persistent storage) - In the site property GoogleMapsServerKey in module OutSystemsMaps  To use this feature, your API key must have Geocoding API, Maps JavaScript API and Directions API activated in the console. Keep in mind that if you have a block from OutSystemsMaps and a block from OutSystemsLocations, the API key must be the same or else an error will be returned.  You can get an API key for Google Maps here: https://developers.google.com/maps/documentation/javascript/get-api-key |
| Center | Text | nao | "42.3517926,-71.0467845" | Defines the location of the map. Works with addresses and coordinates (latitude and longitude).    If left empty, the default location is the OutSystems Boston office. Please note that the map will automatically adjust to show all markers by default. You can override this by setting Location + Zoom parameters.  On maps with markers, the default location will be the location of the first marker on the list. |
| Height | Text | nao |  | Set the height of the map in pixels (""300px""), percentage (""100%"") or viewport height (""100vh""). If the value is empty, the map fits to the parent height.  If using percentages, make sure the map has a parent with a fixed height value, otherwise its height will be 0 (zero).  The parameter value is applied to a CSS variable, used in the OutSystems UI Theme. This variable can be overriden to manipulate the map’s height in your CSS theme.   As an example:  .map-container {     height: 500px;     width: 100%; } |
| StaticMarkers | StaticMarker List | nao |  | Use the Markers parameter to set a location on the map. By default, Markers use the Google Maps default marker but can display custom images.  For more information, visit https://developers.google.com/maps/documentation/javascript/markers |
| OptionalStaticMapConfigs | OptionalStaticMapConfigs | nao |  | Set additional parameters to customize static map's behavior and functionality. |

## Placeholders

- **LicenseInformation** (em `content/content`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnError**(MapId: Text, ErrorCodeId: MapErrors Identifier, ErrorMessage: Text): Event triggered when an error occurs in window.

## Composicao interna

- Usa os blocos: MapCSS
- Scripts exigidos: OutSystemsMaps
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: MapOnError_Callback, ObtainMapKey_OnAfterFetch, OnDestroy, SubscribeEvents, SetApiKey, OnReady, OnInitialize, OnParametersChanged, InitializeProviderMap
- Chama actions do modulo: GetGoogleMapsServerKey, GetMapErrorByErrorCode, RemoveMap, MapEventSubscribe, ChangeMapApiKey, SetMapHeight, LogEvent, GenerateUniqueId, ChangeMarkers, GetHashcode, CreateMap, ChangeMapType, ChangeMapZoom, ChangeMapLocalization, ChangeMapLocation, InitMap (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.MapOnError_Callback = $actions.MapOnError_Callback;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"StaticMap1","source":"IMobileBlock:StaticMap","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnError` resolve o IEventHandler pelo nome do evento e `$b/OnError/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"StaticMap1_OnError","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ErrorCodeId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"MapErrors Identifier"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ErrorMessage","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnError","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnError/MapId","prop":"Value","value":"MapId"}
{"op":"set","target":"$b/OnError/ErrorCodeId","prop":"Value","value":"ErrorCodeId"}
{"op":"set","target":"$b/OnError/ErrorMessage","prop":"Value","value":"ErrorMessage"}
```

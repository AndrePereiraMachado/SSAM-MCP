# LeafletMap

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Maps** | publico | 20 widgets internos

Displays an interactive map on your Reactive Web and Native Mobile apps using Leaflet, an open-source JavaScript library for interactive maps. You can change the default behavior of your map using all the options available in the block. 

Use the AddOn blocks (Markers, MarkerPopup and Shapes) to customize your map.
To add a list of markers, drag the List widget inside the AddOns placeholder together with the Marker.

For more information, visit https://leafletjs.com/

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Center | Text | nao | "42.3517926,-71.0467845" | Defines the location of the map. If left empty, the default location is the OutSystems Boston office. Please note that the map will automatically adjust to show all markers by default. You can override this by setting Location + Zoom parameters.  On maps with markers, the default location will be the location of the first marker on the list.  GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| Height | Text | nao |  | Set the height of the map in pixels (""300px""), percentage (""100%"") or viewport height (""100vh""). If the value is empty, the map fits to the parent height.  If using percentages, make sure the map has a parent with a fixed height value, otherwise its height will be 0 (zero).  The parameter value is applied to a CSS variable, used in the OutSystems UI Theme. This variable can be overriden to manipulate the map’s height in your CSS theme.   As an example:  .map-container {     height: 500px;     width: 100%; } |
| OptionalConfigs | OptionalLeafletMapConfigs | nao |  | Set additional parameters to customize map’s behavior and functionality. |

## Placeholders

- **Events_Placeholder**: Drag-and-drop MapEvent blocks here to listen to map events. (em `content`)
- **AddOns_Placeholder**: Drag-and-drop map addons here to customize your map. You can drag Markers, Shapes and DrawingTools. 
To add a list of markers, drag the List widget inside the AddOns placeholder together with the Marker. (em `content/MapContainer/content/content`)

## Eventos

- **OnError**(MapId: Text, ErrorCode: MapErrors Identifier, ErrorMessage: Text): Event triggered when an error occurs in window.
- **Map_Initialized**(MapId: Text): Event triggered when the Map is initialized.

## Composicao interna

- Usa os blocos: ImagesCSS, MapCSS, LeafletCSS, LeafletRoutingCSS, LeafletDrawCSS
- Scripts exigidos: Leaflet, LeafletDraw, LeafletPathDrag, LeafletEditable, LeafletRoutingMachine, OutSystemsMaps
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, UnsubscribeEvents, SubscribeEvents, MapInitialized_Callback, MapOnError_Callback, OnInitialize, OnReady, OnParametersChanged
- Chama actions do modulo: RemoveMap, MapEventUnsubscribe, MapEventSubscribe, GetMapErrorByErrorCode, LogEvent, GenerateUniqueId, CreateMap, InitMap, SetMapHeight, ChangeMapRespectUserPosition, ChangeMapZoom, ChangeMapLocation, ChangeMapOffset, ChangeMapRespectUserZoom (contratos em [actions.md](../actions.md))

## JavaScript

`UnsubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.MapInitialized_Callback = $actions.MapInitialized_Callback;

$parameters.MapOnError_Callback = $actions.MapOnError_Callback;
```

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.MapInitialized_Callback = $actions.MapInitialized_Callback;

$parameters.MapOnError_Callback = $actions.MapOnError_Callback;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"LeafletMap1","source":"IMobileBlock:LeafletMap","as":"$b"}
{"op":"create","parent":"$b/Events_Placeholder","type":"IExpression","as":"$eEvents_Placeholder"}
{"op":"create","parent":"$b/AddOns_Placeholder","type":"IExpression","as":"$eAddOns_Placeholder"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnError` resolve o IEventHandler pelo nome do evento e `$b/OnError/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"LeafletMap1_OnError","as":"$h"}
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

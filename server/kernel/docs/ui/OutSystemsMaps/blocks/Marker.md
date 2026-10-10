# Marker

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Marker** | publico | 6 widgets internos

Adds a location to OutSystems Maps Map block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | Text | sim |  | Defines the marker position on the map.   GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| OptionalConfigs | OptionalMarkerConfigs | nao |  | Set additional parameters to customize the marker’s behavior and functionality. |

## Placeholders

- **MarkerEvents** (em `content`)

## Eventos

- **OnClick**(MapWidgetId: Text, MarkerWidgetId: Text, LatLng: Coordinates): Marker event that will be fired when the user clicks on the marker.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Callback_Event, OnInitialize, OnReady, OnParametersChanged, SubscribeEvents, OnDestroy
- Chama actions do modulo: GenerateUniqueId, CreateMarkerByUniqueID, ChangeMarkerTitle, ChangeMarkerLocation, ChangeMarkerLabel, LogEvent, ChangeMarkerIconHeight, ChangeMarkerAllowDrag, ChangeMarkerIconUrl, ChangeMarkerIconWidth, MarkerEventSubscribe, RemoveMarker (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnClick_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Marker1","source":"IMobileBlock:Marker","as":"$b"}
{"op":"set","target":"$b/Position","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/MarkerEvents","type":"IExpression","as":"$eMarkerEvents"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Marker1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MarkerWidgetId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"LatLng","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnClick/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnClick/MarkerWidgetId","prop":"Value","value":"MarkerWidgetId"}
{"op":"set","target":"$b/OnClick/LatLng","prop":"Value","value":"LatLng"}
```

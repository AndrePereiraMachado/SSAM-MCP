# MarkerPopup

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Marker** | publico | 19 widgets internos

Adds a location and a popup to OutSystems Maps Map block. By default, the popup will have a layout that can be customized or removed.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | Text | sim |  | Defines the marker position on the map.   GMaps - Works with addresses and coordinates (lat and lng). Example: “34.56,45.65” or “55 Thomson Pl 2nd floor, Boston, MA 02210, United States”. Leaflet - Works with coordinates (lat and lng) only. Example: “34.56,45.65”. |
| OptionalConfigs | OptionalPopupMarkerConfigs | nao |  | Set additional parameters to customize the popup marker’s behavior and functionality. |

## Placeholders

- **Popup** (em `content`) | nasce com: WebBlockInstance:Layout_MarkerPopup (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **MarkerEvents** (em `content`)

## Eventos

- **OnClick**(MapWidgetId: Text, MarkerWidgetId: Text, LatLng: Coordinates): Marker event that will be fired when the user clicks on the marker.

## Composicao interna

- Usa os blocos: Layout_MarkerPopup
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnParametersChanged, SubscribeEvents, OnReady, Callback_Event, OnDestroy
- Chama actions do modulo: GenerateUniqueId, LogEvent, ChangeMarkerLabel, ChangeMarkerIconHeight, ChangeMarkerAllowDrag, ChangeMarkerIconUrl, ChangeMarkerLocation, ChangeMarkerTitle, ChangeMarkerIconWidth, MarkerEventSubscribe, CreateMarkerByUniqueID, RemoveMarker (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnClick_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MarkerPopup1","source":"IMobileBlock:MarkerPopup","empty":true,"as":"$b"}
{"op":"set","target":"$b/Position","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/MarkerEvents","type":"IExpression","as":"$eMarkerEvents"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MarkerPopup1_OnClick","as":"$h"}
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

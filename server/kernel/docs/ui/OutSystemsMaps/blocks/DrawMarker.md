# DrawMarker

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Drawing_Tools** | publico | 2 widgets internos

Drag this block inside the DrawingTools placeholder to allow users to add markers to the map.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IconURL | Text | nao |  | Set the icon image to be applied to the marker.  By default, markers use the Google Maps default marker. |
| AllowDrag | Boolean | nao |  | Set if users are able to drag the marker. By default, markers are not draggable. |

## Placeholders

Nenhum.

## Eventos

- **OnDrawingChange**(MapWidgetId: Text, MarkerId: Text, IsNewMarker: Boolean, Coordinates: Coordinates, Location: Text): Event fired when the user completes, edits, or drags a marker.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Callback_Event, OnParametersChanged, OnReady, OnInitialize, OnDestroy, SubscribeEvents
- Chama actions do modulo: ChangeToolAllowDrag, LogEvent, ChangeToolIconUrl, AddTool, GenerateUniqueId, ToolsEventUnSubscribe, RemoveTool, ToolsEventSubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnDestroy` / no `GetCallbackHandler`:

```js
$parameters.OnMarkerAdd_Callback = $actions.Callback_Event
```

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnMarkerAdd_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DrawMarker1","source":"IMobileBlock:DrawMarker","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnDrawingChange` resolve o IEventHandler pelo nome do evento e `$b/OnDrawingChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DrawMarker1_OnDrawingChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MarkerId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsNewMarker","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Coordinates","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Location","as":"$p5"}
{"op":"set","target":"$p5","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnDrawingChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnDrawingChange/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnDrawingChange/MarkerId","prop":"Value","value":"MarkerId"}
{"op":"set","target":"$b/OnDrawingChange/IsNewMarker","prop":"Value","value":"IsNewMarker"}
{"op":"set","target":"$b/OnDrawingChange/Coordinates","prop":"Value","value":"Coordinates"}
{"op":"set","target":"$b/OnDrawingChange/Location","prop":"Value","value":"Location"}
```

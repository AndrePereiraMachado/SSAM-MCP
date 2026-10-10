# DrawPolyline

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Drawing_Tools** | publico | 2 widgets internos

Drag this block inside the DrawingTools placeholder to allow users to add polylines to the map.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AllowDrag | Boolean | nao |  | Set if users are able to drag the polyline. By default, polylines are not draggable. |
| AllowEdit | Boolean | nao |  | Set if users are able to edit the polyline. By default, polylines are not editable. |
| Stroke | Stroke | nao |  | Set additional parameters to customize the shape’s stroke. |

## Placeholders

Nenhum.

## Eventos

- **OnDrawingChange**(MapWidgetId: Text, PolylineId: Text, IsNewPolyline: Boolean, CoordinatesList: Coordinates List, Location: Text List): Event fired when the user completes, edits, or drags a polyline.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, SubscribeEvents, Callback_Event, OnReady, OnInitialize, OnDestroy
- Chama actions do modulo: LogEvent, ChangeToolStrokeColor, ChangeToolStrokeOpacity, ChangeToolAllowDrag, ChangeToolAllowEdit, ChangeToolStrokeWeight, ToolsEventSubscribe, AddTool, GenerateUniqueId, RemoveTool, ToolsEventUnSubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnPolylineCreated_Callback = $actions.Callback_Event
```

`OnDestroy` / no `GetCallbackHandler`:

```js
$parameters.OnPolylineCreated_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DrawPolyline1","source":"IMobileBlock:DrawPolyline","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnDrawingChange` resolve o IEventHandler pelo nome do evento e `$b/OnDrawingChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DrawPolyline1_OnDrawingChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"PolylineId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsNewPolyline","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"CoordinatesList","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Coordinates List"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Location","as":"$p5"}
{"op":"set","target":"$p5","prop":"DataType","value":"Text List"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnDrawingChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnDrawingChange/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnDrawingChange/PolylineId","prop":"Value","value":"PolylineId"}
{"op":"set","target":"$b/OnDrawingChange/IsNewPolyline","prop":"Value","value":"IsNewPolyline"}
{"op":"set","target":"$b/OnDrawingChange/CoordinatesList","prop":"Value","value":"CoordinatesList"}
{"op":"set","target":"$b/OnDrawingChange/Location","prop":"Value","value":"Location"}
```

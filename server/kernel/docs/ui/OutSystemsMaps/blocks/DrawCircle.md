# DrawCircle

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Drawing_Tools** | publico | 2 widgets internos

Drag this block inside the DrawingTools placeholder to allow users to draw circles on the map.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AllowDrag | Boolean | nao |  | Set if users are able to drag the circle. By default, circles are not draggable. |
| AllowEdit | Boolean | nao |  | Set if users are able to edit the circle. By default, circles are not editable. |
| Stroke | Stroke | nao |  | Set additional parameters to customize the shape’s stroke. |
| Fill | Fill | nao |  | Set additional parameters to customize the shape’s fill. |

## Placeholders

Nenhum.

## Eventos

- **OnDrawingChange**(MapWidgetId: Text, CircleId: Text, IsNewCircle: Boolean, Coordinates: Coordinates, Center: Text, Radius: Integer): Event fired when the user completes, edits, or drags a circle.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, Callback_Event, OnReady, OnDestroy, OnInitialize, SubscribeEvents
- Chama actions do modulo: ChangeToolFillColor, LogEvent, ChangeToolAllowDrag, ChangeToolStrokeOpacity, ChangeToolStrokeWeight, ChangeToolAllowEdit, ChangeToolStrokeColor, ChangeToolFillOpacity, AddTool, RemoveTool, ToolsEventUnSubscribe, GenerateUniqueId, ToolsEventSubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnDestroy` / no `GetCallbackHandler`:

```js
$parameters.OnCircleCreated_Callback = $actions.Callback_Event
```

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnCircleCreated_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DrawCircle1","source":"IMobileBlock:DrawCircle","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnDrawingChange` resolve o IEventHandler pelo nome do evento e `$b/OnDrawingChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DrawCircle1_OnDrawingChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"CircleId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsNewCircle","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Coordinates","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Center","as":"$p5"}
{"op":"set","target":"$p5","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Radius","as":"$p6"}
{"op":"set","target":"$p6","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnDrawingChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnDrawingChange/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnDrawingChange/CircleId","prop":"Value","value":"CircleId"}
{"op":"set","target":"$b/OnDrawingChange/IsNewCircle","prop":"Value","value":"IsNewCircle"}
{"op":"set","target":"$b/OnDrawingChange/Coordinates","prop":"Value","value":"Coordinates"}
{"op":"set","target":"$b/OnDrawingChange/Center","prop":"Value","value":"Center"}
{"op":"set","target":"$b/OnDrawingChange/Radius","prop":"Value","value":"Radius"}
```

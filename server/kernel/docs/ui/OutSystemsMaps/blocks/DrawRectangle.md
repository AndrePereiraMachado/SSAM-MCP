# DrawRectangle

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Drawing_Tools** | publico | 2 widgets internos

Drag this block inside the DrawingTools placeholder to allow users to add rectangles to the map.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| AllowDrag | Boolean | nao |  | Set if users are able to drag the rectangle. By default, rectangles are not draggable. |
| AllowEdit | Boolean | nao |  | Set if users are able to edit the rectangle. By default, rectangles are not editable. |
| Stroke | Stroke | nao |  | Set additional parameters to customize the shape’s stroke. |
| Fill | Fill | nao |  | Set additional parameters to customize the shape’s fill. |

## Placeholders

Nenhum.

## Eventos

- **OnDrawingChange**(MapWidgetId: Text, RectangleId: Text, IsNewRectangle: Boolean, Bound: Bounds, Location: Text): Event fired when the user completes, edits, or drags a rectangle.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Callback_Event, OnDestroy, OnReady, SubscribeEvents, OnInitialize, OnParametersChanged
- Chama actions do modulo: ToolsEventUnSubscribe, RemoveTool, AddTool, ToolsEventSubscribe, GenerateUniqueId, ChangeToolStrokeWeight, LogEvent, ChangeToolAllowEdit, ChangeToolFillOpacity, ChangeToolAllowDrag, ChangeToolStrokeColor, ChangeToolStrokeOpacity, ChangeToolFillColor (contratos em [actions.md](../actions.md))

## JavaScript

`OnDestroy` / no `GetCallbackHandler`:

```js
$parameters.OnRectangleCreated_Callback = $actions.Callback_Event
```

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnRectangleCreated_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DrawRectangle1","source":"IMobileBlock:DrawRectangle","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnDrawingChange` resolve o IEventHandler pelo nome do evento e `$b/OnDrawingChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DrawRectangle1_OnDrawingChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"RectangleId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsNewRectangle","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Bound","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Bounds"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Location","as":"$p5"}
{"op":"set","target":"$p5","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnDrawingChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnDrawingChange/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnDrawingChange/RectangleId","prop":"Value","value":"RectangleId"}
{"op":"set","target":"$b/OnDrawingChange/IsNewRectangle","prop":"Value","value":"IsNewRectangle"}
{"op":"set","target":"$b/OnDrawingChange/Bound","prop":"Value","value":"Bound"}
{"op":"set","target":"$b/OnDrawingChange/Location","prop":"Value","value":"Location"}
```

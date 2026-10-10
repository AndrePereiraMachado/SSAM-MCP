# Generic

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Shapes** | privado | 4 widgets internos

Helper to add a shape to OutSystems Maps Map block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Locations | Text List | nao |  |  |
| Center | Text | nao |  | Location that defines the center of the circle. Works with an address or coordinates (latitude and longitude). |
| Radius | Integer | nao |  | Defines the radius of the circle in meters. |
| OptionalConfigs | OptionalShapeConfigs | nao |  |  |
| UniqueId | Text | nao |  |  |
| ShapeType | ShapeType Identifier | sim |  |  |
| Bounds | Text | nao |  |  |

Valores possiveis (static entities):

- **Entities.ShapeType**: Polygon, Circle, Rectangle, Polyline

## Placeholders

Nenhum.

## Eventos

- **OnClick**(MapWidgetId: Text, ShapeId: Text)

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, Callback_Event, SubscribeEvents, OnDestroy, OnParametersChanged, OnReady
- Chama actions do modulo: GetHashcode, ShapeEventSubscribe, RemoveShape, LogEvent, ChangeShapeFillColor, ChangeShapeStrokeOpacity, ChangeShapeFillOpacity, ChangeShapeAllowEdit, ChangeShapeStrokeColor, ChangeShapeAllowDrag, ChangeShapeCenter, ChangeShapeStrokeWeight, ChangeShapeRadius, ChangeShapeLocations, CreateShape (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnClick_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Generic1","source":"IMobileBlock:Generic","as":"$b"}
{"op":"set","target":"$b/ShapeType","prop":"Value","value":"<ShapeType Identifier>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Generic1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ShapeId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnClick/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnClick/ShapeId","prop":"Value","value":"ShapeId"}
```

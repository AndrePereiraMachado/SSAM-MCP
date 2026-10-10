# MapEvent

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Map_Events** | publico | 7 widgets internos

This block enables to listen to events of a given map. 
Drag-and-drop this block inside the map event placeholder and pick the event to listen. The list of events that you can listen to include: click, doubleClick, dragEnd, rightClick and zoomChanged.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| EventName | MapEventTriggered Identifier | sim |  | Define the name of the event to be added to the Map element. |

Valores possiveis (static entities):

- **Entities.MapEventTriggered**: DragEnd, DoubleClick, Click, RightClick, ZoomChanged

## Placeholders

Nenhum.

## Eventos

- **Action**(MapWidgetId: Text, EventName: Text, MapObj: Object, LatLng: Coordinates) [obrigatorio]: The map event will be fired once the event with the selected EventName occurs.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnReady, OnDestroy, Callback_Event
- Chama actions do modulo: GenerateUniqueId, MapEventTriggeredSubscribe, MapEventTriggeredUnsubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnReady` / no `GetActionsHandler`:

```js
$parameters.CallbackEvent = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MapEvent1","source":"IMobileBlock:MapEvent","as":"$b"}
{"op":"set","target":"$b/EventName","prop":"Value","value":"<MapEventTriggered Identifier>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Action` resolve o IEventHandler pelo nome do evento e `$b/Action/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MapEvent1_Action","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"EventName","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapObj","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Object"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"LatLng","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Action","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Action/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/Action/EventName","prop":"Value","value":"EventName"}
{"op":"set","target":"$b/Action/MapObj","prop":"Value","value":"MapObj"}
{"op":"set","target":"$b/Action/LatLng","prop":"Value","value":"LatLng"}
```

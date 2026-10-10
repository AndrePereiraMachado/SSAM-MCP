# MarkerEvent

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Marker_Events** | publico | 7 widgets internos

This block enables to listen to events of a given Marker on a Map. 
Drag-and-drop this block inside the marker placeholder and pick the event to listen. The list of events that you can listen to include: doubleClick, dragEnd and rightClick.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| EventName | MarkerEventTriggered Identifier | sim |  | Define the name of the event to be added to the Marker element. |

Valores possiveis (static entities):

- **Entities.MarkerEventTriggered**: DragEnd, OnClick, DoubleClick, RightClick

## Placeholders

Nenhum.

## Eventos

- **Action**(MapWidgetId: Text, MarkerWidgetId: Text, EventName: Text, LatLng: Coordinates) [obrigatorio]: The marker event will be fired once the event with the selected EventName occurs.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnInitialize, OnDestroy, Callback_Event
- Chama actions do modulo: MarkerEventTriggeredSubscribe, GenerateUniqueId, MarkerEventTriggeredUnsubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnReady` / no `GetActionsHandler`:

```js
$parameters.CallbackEvent = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MarkerEvent1","source":"IMobileBlock:MarkerEvent","as":"$b"}
{"op":"set","target":"$b/EventName","prop":"Value","value":"<MarkerEventTriggered Identifier>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Action` resolve o IEventHandler pelo nome do evento e `$b/Action/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MarkerEvent1_Action","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MarkerWidgetId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"EventName","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"LatLng","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Action","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Action/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/Action/MarkerWidgetId","prop":"Value","value":"MarkerWidgetId"}
{"op":"set","target":"$b/Action/EventName","prop":"Value","value":"EventName"}
{"op":"set","target":"$b/Action/LatLng","prop":"Value","value":"LatLng"}
```

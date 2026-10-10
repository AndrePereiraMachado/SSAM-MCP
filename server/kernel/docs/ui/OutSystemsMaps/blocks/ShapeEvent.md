# ShapeEvent

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Shape_Events** | publico | 7 widgets internos

This block enables to listen to events of a given Shape on a Map. 
Drag-and-drop this block inside the shape placeholder and pick the event to listen. The list of events that you can listen to include: doubleClick, dragEnd and rightClick.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| EventName | ShapeEventTriggered Identifier | sim |  | Define the name of the event to be added to the Shape element. |

Valores possiveis (static entities):

- **Entities.ShapeEventTriggered**: DragEnd, ShapeChanged

## Placeholders

Nenhum.

## Eventos

- **Action**(MapWidgetId: Text, ShapeWidgetId: Text, EventName: Text) [obrigatorio]: The shape event will be fired once the event with the selected EventName occurs.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Callback_Event, OnInitialize, OnDestroy, OnReady
- Chama actions do modulo: GenerateUniqueId, ShapeEventTriggeredUnsubscribe, ShapeEventTriggeredSubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnReady` / no `GetActionsHandler`:

```js
$parameters.CallbackEvent = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ShapeEvent1","source":"IMobileBlock:ShapeEvent","as":"$b"}
{"op":"set","target":"$b/EventName","prop":"Value","value":"<ShapeEventTriggered Identifier>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Action` resolve o IEventHandler pelo nome do evento e `$b/Action/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ShapeEvent1_Action","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ShapeWidgetId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"EventName","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Action","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Action/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/Action/ShapeWidgetId","prop":"Value","value":"ShapeWidgetId"}
{"op":"set","target":"$b/Action/EventName","prop":"Value","value":"EventName"}
```

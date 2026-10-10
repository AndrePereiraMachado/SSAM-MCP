# TouchEvents

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 5 widgets internos

Enables touch events on a specific widget.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | Element that will be affected by the gesture |
| PreventDefaults | Boolean | nao | True | If Prevent Default should be applied |

## Placeholders

Nenhum.

## Eventos

- **Move**(X: Decimal, Y: Decimal, OffsetX: Decimal, OffsetY: Decimal, Evt: Object): Event triggered when the mouse events move.
- **Start**(X: Decimal, Y: Decimal): The event is triggered as the touch movement starts.
- **End**(X: Decimal, Y: Decimal, OffsetX: Decimal, OffsetY: Decimal, TimeTaken: Decimal): The event is triggered after the movement event finishes.

## Composicao interna

- Scripts exigidos: TouchTrack
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnMove, OnReady, OnEnd, OnDestroy, OnStart, OnParametersChanged

## JavaScript

`OnReady` / no `BindEvents`:

```js
var touchTrack = new TouchTrack();
$parameters.isBound = false;

var el = document.getElementById($parameters.WidgetId);

if (el) {
    touchTrack.init(el, $actions.OnStart, $actions.OnMove, $actions.OnEnd);
    $parameters.isBound = true;
}


$parameters.Obj = touchTrack;
```

`OnDestroy` / no `Destroy`:

```js
$parameters.Obj.destroy();
```

`OnParametersChanged` / no `SetPreventDefault`:

```js
$parameters.Obj.setPreventDefault($parameters.Prevent);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"TouchEvents1","source":"IMobileBlock:TouchEvents","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Move` resolve o IEventHandler pelo nome do evento e `$b/Move/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"TouchEvents1_Move","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"X","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Y","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"OffsetX","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"OffsetY","as":"$p4"}
{"op":"set","target":"$p4","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Evt","as":"$p5"}
{"op":"set","target":"$p5","prop":"DataType","value":"Object"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Move","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Move/X","prop":"Value","value":"X"}
{"op":"set","target":"$b/Move/Y","prop":"Value","value":"Y"}
{"op":"set","target":"$b/Move/OffsetX","prop":"Value","value":"OffsetX"}
{"op":"set","target":"$b/Move/OffsetY","prop":"Value","value":"OffsetY"}
{"op":"set","target":"$b/Move/Evt","prop":"Value","value":"Evt"}
```

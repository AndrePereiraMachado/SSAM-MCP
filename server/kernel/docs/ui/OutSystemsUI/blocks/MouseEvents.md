# MouseEvents

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 5 widgets internos

Enables Mouse events on a specific widget.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | Element that will be affected by the gesture |
| PreventDefaults | Boolean | nao | True | If Prevent Default should be applied |

## Placeholders

Nenhum.

## Eventos

- **Move**(X: Decimal, Y: Decimal, OffsetX: Decimal, OffsetY: Decimal, Evt: Object): Event triggered when the mouse events move.
- **End**(X: Decimal, Y: Decimal, OffsetX: Decimal, OffsetY: Decimal, TimeTaken: Decimal): Event triggered when the mouse events end.
- **Start**(X: Decimal, Y: Decimal): Event triggered as the mouse events start.

## Composicao interna

- Scripts exigidos: MouseTrack
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnEnd, OnParametersChanged, OnMove, OnReady, OnStart, OnInitialize, OnDestroy

## JavaScript

`OnParametersChanged` / no `SetPreventDefault`:

```js
$parameters.Obj.setPreventDefault($parameters.Prevent);
```

`OnReady` / no `BindEvents`:

```js
var mouseTrack = new MouseTrack();
$parameters.isBound = false;

var el = document.getElementById($parameters.WidgetId);

if (el) {
    mouseTrack.init(el, $actions.OnStart, $actions.OnMove, $actions.OnEnd);
    mouseTrack.setPreventDefault($parameters.PreventDefaults);
    $parameters.isBound = true;
}


$parameters.Obj = mouseTrack;
```

`OnDestroy` / no `Destroy`:

```js
$parameters.Obj.destroy();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MouseEvents1","source":"IMobileBlock:MouseEvents","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Move` resolve o IEventHandler pelo nome do evento e `$b/Move/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MouseEvents1_Move","as":"$h"}
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

# SwipeEvents

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 6 widgets internos

Enable swipe events on a specific widget.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| WidgetId | Text | sim |  | Element that will be swipeable |

## Placeholders

Nenhum.

## Eventos

- **SwipeUp**(): The event is triggered after a swipe up.
- **SwipeLeft**(): The event is triggered after a swipe left.
- **SwipeRight**(): The event is triggered after a swipe right.
- **SwipeDown**(): The event is triggered after a swipe down.

## Composicao interna

- Usa os blocos: TouchEvents
- Actions do bloco: OnGestureMove, OnGestureEnd

## JavaScript

`OnGestureMove` / no `PreventDefaut`:

```js

$parameters.Evt.preventDefault();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"SwipeEvents1","source":"IMobileBlock:SwipeEvents","as":"$b"}
{"op":"set","target":"$b/WidgetId","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/SwipeUp` resolve o IEventHandler pelo nome do evento e `$b/SwipeUp/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"SwipeEvents1_SwipeUp","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/SwipeUp","prop":"Handler","value":"$h"}
```

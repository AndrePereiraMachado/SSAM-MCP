# DEPRECATED_Badge

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 2 widgets internos

Displays a number as notification, a nice way to notify a user about new messages or tasks.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Number | Long Integer | sim |  | Number to be displayed |
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.PrimaryColor | Background color of the Block |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Badge1","source":"IMobileBlock:DEPRECATED_Badge","as":"$b"}
{"op":"set","target":"$b/Number","prop":"Value","value":"<Long Integer>"}
```

# DEPRECATED_CardBackground

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 4 widgets internos

Card with a background image, GIF or video. Simply drag the background element to the Background placeholder

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| BackgroundColor | DEPRECATED_Color Identifier | nao | Entities.DEPRECATED_Color.Black | Background color of the Block |
| MinHeight | Integer | nao |  | Set the minimum height of the Card, in pixels. Content will be vertically aligned by default. |

Valores possiveis (static entities):

- **Entities.DEPRECATED_Color**: Violet, None, Blue, Black, Red, Grey, Orange, Green, White, PrimaryColor

## Placeholders

- **Content**: Add content to this placeholder (em `content`)
- **BackgroundImage**: Drag a background image, GIF or video to this placeholder (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_CardBackground1","source":"IMobileBlock:DEPRECATED_CardBackground","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/BackgroundImage","type":"IExpression","as":"$eBackgroundImage"}
```

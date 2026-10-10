# Badge

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 2 widgets internos

Display content as notification. 

It's used to notify user about new messages or tasks.

Use the parameters to choose some options, like color, shape, size and light theme.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Number | Integer | nao | 8 | Number that will appear inside the badge. |
| Color | Color Identifier | nao | Entities.Color.Primary | Set the color. |
| Shape | Shape Identifier | nao | Entities.Shape.Rounded | Set the shape. |
| Size | Size Identifier | nao |  | Set the size. |
| IsLight | Boolean | nao | False | Use the lightest color version for the background and the darker color version for the text. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.Shape**: Rounded, Sharp, SoftRounded
- **Entities.Size**: Small, Medium

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Badge1","source":"IWebBlock:Badge","as":"$b"}
```

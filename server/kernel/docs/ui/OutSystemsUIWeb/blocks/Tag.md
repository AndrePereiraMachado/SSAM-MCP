# Tag

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 2 widgets internos

Displays text in a colored and shapped tag layout.

Use it to show a short burst of information (one word recomended).

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Primary | Set the backgound color. |
| Shape | Shape Identifier | nao | Entities.Shape.Rounded | Set the shape. |
| Size | Size Identifier | nao |  | Set the size. |
| IsLight | Boolean | nao | False | Use the lightest color version for the background and the darker color version for the text. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.Shape**: Rounded, Sharp, SoftRounded
- **Entities.Size**: Small, Medium

## Placeholders

- **Content**: Drag your content to this placeholder. (em `TagWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Tag1","source":"IWebBlock:Tag","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```

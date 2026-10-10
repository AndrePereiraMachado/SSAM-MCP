# UserInitials

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 2 widgets internos

Display initials of the user in a nice circular badge.

Ideal to display information of the currently logged user.

Add the pattern to your screen and in the Name property, provide the user name, and it will display the user initials only.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Name | Text | nao | "JD" | The username to be used in the pattern. |
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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"UserInitials1","source":"IWebBlock:UserInitials","as":"$b"}
```

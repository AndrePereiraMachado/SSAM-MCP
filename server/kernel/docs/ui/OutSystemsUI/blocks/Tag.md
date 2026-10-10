# Tag

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 1 widgets internos

Display text highlighting its importance.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Primary | Background color of the Block |
| Size | Size Identifier | nao |  | Set the shape. |
| Shape | Shape Identifier | nao | Entities.Shape.Rounded | Set the shape. |
| IsLight | Boolean | nao | False | Use the lightest color version for the background and the darker color version for the text. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent
- **Entities.Size**: Small, Medium
- **Entities.Shape**: SoftRounded, Sharp, Rounded

## Placeholders

- **Tag**: Text

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Tag1","source":"IMobileBlock:Tag","as":"$b"}
{"op":"create","parent":"$b/Tag","type":"IExpression","as":"$eTag"}
```

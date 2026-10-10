# CardBackground

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 4 widgets internos

Card with a background image, GIF or video. Simply drag the background element to the Background placeholder

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Transparent | Background color of the Block |
| MinHeight | Integer | nao |  | Set the minimum height of the Card, in pixels. Content will be vertically aligned by default. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"CardBackground1","source":"IMobileBlock:CardBackground","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/BackgroundImage","type":"IExpression","as":"$eBackgroundImage"}
```

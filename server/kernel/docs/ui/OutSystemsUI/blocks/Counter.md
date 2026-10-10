# Counter

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 2 widgets internos

Use counters to give feedback about the current count of several elements.

Very useful on dashboards or summary pages.

Add content to the placeholder, then, set up the orientation and Height of the Block.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| BackgroundColor | Color Identifier | nao | Entities.Color.Neutral0 | Background color of the Block |
| IsVertical | Boolean | nao | False | If set to True, the content will be displayed vertically. |
| Height | Text | nao | "100" | Height of the block, use Pixel units. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent

## Placeholders

- **Content**: Drag your content to this placeholder. (em `CounterWrapper/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Counter1","source":"IMobileBlock:Counter","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

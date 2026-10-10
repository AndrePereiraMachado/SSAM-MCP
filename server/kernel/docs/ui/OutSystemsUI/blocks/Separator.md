# Separator

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 2 widgets internos

Allows to split information with a horizontal line.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsVertical | Boolean | nao | False | If set as true, then the Separator becomes vertical. |
| Space | Space Identifier | nao | Entities.Space.Base | Set the space around the Separator line. |
| Color | Color Identifier | nao | Entities.Color.Neutral4 | Set the color of the Separator line. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Space**: XXLarge, ExtraLarge, Large, None, Medium, ExtraSmall, Base, Small
- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Separator1","source":"IMobileBlock:Separator","as":"$b"}
```

# FloatingContent

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 7 widgets internos

Inserts a floating panel with content docked to a direction in the page

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | Position Identifier | sim |  | Place where the Floating Content will be in the screen |
| UseFullHeight | Boolean | nao | False | Defines if the panel has full height |
| UseFullWidth | Boolean | nao | False | Defines if the panel has full width |
| UseMargin | Boolean | nao | True | Defines if the panel has margin |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Position**: Right, TopRight, BottomLeft, Left, TopLeft, Center, BottomRight, Top, Bottom

## Placeholders

- **Content**: Insert floating content here (em `FloatingContent/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"FloatingContent1","source":"IMobileBlock:FloatingContent","as":"$b"}
{"op":"set","target":"$b/Position","prop":"Value","value":"<Position Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

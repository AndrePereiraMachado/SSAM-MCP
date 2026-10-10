# Columns2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 3 widgets internos

Split content in 2 columns with responsive capabilities to improve the way information is displayed.

Place this Block on your Screen and simply add content to each placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| GutterSize | GutterSize Identifier | nao | Entities.GutterSize.Base | Defines the space between columns. |
| TabletBehavior | BreakColumns Identifier | nao | Entities.BreakColumns.None | Responsive behavior for tablet. |
| PhoneBehavior | BreakColumns Identifier | nao | Entities.BreakColumns.None | Responsive behavior for phone. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.GutterSize**: XXLarge, Large, ExtraSmall, Small, ExtraLarge, Medium, None, Base
- **Entities.BreakColumns**: Last, Middle, None, First, All

## Placeholders

- **Column1**: Drag your content to this placeholder. (em `content`)
- **Column2**: Drag your content to this placeholder. (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Columns21","source":"IMobileBlock:Columns2","as":"$b"}
{"op":"create","parent":"$b/Column1","type":"IExpression","as":"$eColumn1"}
{"op":"create","parent":"$b/Column2","type":"IExpression","as":"$eColumn2"}
```

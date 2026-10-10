# DEPRECATED_ProgressBarV2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 4 widgets internos

Animated progress bar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Progress | Integer | sim |  | Progress percentage. Usually a number from from 0 to 100. |
| Color | Color Identifier | nao | Entities.Color.Primary | The background color of the progress bar |
| Height | Integer | nao | 12 | Height, in pixels. |
| AnimateInitialProgress | Boolean | nao | True | When True, the progress bar will show an animation going from zero to its initial progress. |
| Text | Text | nao |  | Text to be displayed, if not text is defined, the progress percentage is shown |
| Shape | Shape Identifier | nao | Entities.Shape.Rounded | Set the shape. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent
- **Entities.Shape**: SoftRounded, Sharp, Rounded

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_ProgressBarV21","source":"IMobileBlock:DEPRECATED_ProgressBarV2","as":"$b"}
{"op":"set","target":"$b/Progress","prop":"Value","value":"<Integer>"}
```

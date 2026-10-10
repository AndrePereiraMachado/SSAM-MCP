# AlignCenter

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 1 widgets internos

Vertically aligns multiple elements with different heights.

Add two or more elements inside the placeholder and they will be vertically centered. Ideal to align Buttons with other different elements like text.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsHorizontal | Boolean | nao | True | Set the orientation of the content inside. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Add items to align

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"AlignCenter1","source":"IMobileBlock:AlignCenter","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

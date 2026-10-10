# CenterContent

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 4 widgets internos

Vertically aligns content to the middle of its parent.

Place this block inside a container with a given height and add content to the placeholder, that content will be vertically centered. 

Ideal for full height screens without much content.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Height | Integer | nao |  | Height of the block, in pixels. If the value is empty, it will try to adjust to the parent's height. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Top**: Add top content to this placeholder (em `content`)
- **Center**: Add content to be centered to this placeholder (em `content`)
- **Bottom**: Add bottom content to this placeholder (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"CenterContent1","source":"IMobileBlock:CenterContent","as":"$b"}
{"op":"create","parent":"$b/Top","type":"IExpression","as":"$eTop"}
{"op":"create","parent":"$b/Center","type":"IExpression","as":"$eCenter"}
{"op":"create","parent":"$b/Bottom","type":"IExpression","as":"$eBottom"}
```

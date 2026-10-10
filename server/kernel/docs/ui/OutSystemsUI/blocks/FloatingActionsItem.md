# FloatingActionsItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 3 widgets internos

Used within the FloatingActions Pattern. Should be placed inside the FloatingActions's Item placeholder.

Drag into the FloatingActions Pattern as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Label**: Drag the Label widget to this placeholder. (em `content`)
- **Item**: Drag the Icon widget to this placeholder. (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"FloatingActionsItem1","source":"IMobileBlock:FloatingActionsItem","as":"$b"}
{"op":"create","parent":"$b/Label","type":"IExpression","as":"$eLabel"}
{"op":"create","parent":"$b/Item","type":"IExpression","as":"$eItem"}
```

# BottomBarItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 3 widgets internos

Item to be placed inside the Bottom Bar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Icon**: Drag bottom bar item icon (em `content`)
- **Text**: Insert bottom bar item text (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"BottomBarItem1","source":"IMobileBlock:BottomBarItem","as":"$b"}
{"op":"create","parent":"$b/Icon","type":"IExpression","as":"$eIcon"}
{"op":"create","parent":"$b/Text","type":"IExpression","as":"$eText"}
```

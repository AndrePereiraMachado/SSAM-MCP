# DEPRECATED_TabsHeaderItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 1 widgets internos

Item for placeholder Header in the Tabs Block. Drag as many items as you need.

The headers can have rich information like counters, badges or icons.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Title**: Use this placeholder to set your title.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_TabsHeaderItem1","source":"IMobileBlock:DEPRECATED_TabsHeaderItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
```

# BreadcrumbsItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 3 widgets internos

Used in the Content placeholder of the Breadcrumbs Block.

Fill the Title placeholder with your title.
Drag an icon to the Icon placeholder, usually "angle_right", "caret_right" or "chevron_right". Place links for the level required to offer the navigation.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Title**: Use this placeholder to set your title. (em `BreadcrumbsItemWrapper/content`)
- **Icon**: Drag the Icon widget to this placeholder. (em `BreadcrumbsItemWrapper/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"BreadcrumbsItem1","source":"IMobileBlock:BreadcrumbsItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/Icon","type":"IExpression","as":"$eIcon"}
```

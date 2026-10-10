# BreadcrumbsItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 3 widgets internos

Used in the Content placeholder of the Breadcrumbs Block.

Fill the Title placeholder with your title.
Drag an icon to the Icon placeholder, usually "angle_right", "caret_right" or "chevron_right". Place links for the level required to offer the navigation.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Title**: Use this placeholder to set your title. (em `BreadcrumbsItemWrapper`)
- **Icon**: Drag the Icon widget to this placeholder. (em `BreadcrumbsItemWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"BreadcrumbsItem1","source":"IWebBlock:BreadcrumbsItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Icon","type":"IExpressionWidget","as":"$eIcon"}
```

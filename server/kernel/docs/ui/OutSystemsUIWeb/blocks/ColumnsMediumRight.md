# ColumnsMediumRight

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Structure** | publico | 3 widgets internos

Split content in 2 columns with responsive capabilities to improve the way information is displayed. The right column will be smaller.

Place this Web Block on your Web Screen and simply add content to each placeholder.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| GutterSize | GutterSize Identifier | nao | Entities.GutterSize.Gutter_L | Set the gutter size. |
| TabletBehavior | BreakColumns Identifier | nao | Entities.BreakColumns.None | Responsive behavior for tablet. |
| PhoneBehavior | BreakColumns Identifier | nao | Entities.BreakColumns.All | Responsive behavior for phone. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.GutterSize**: Gutter_XS, Gutter_XL, Gutter_M, Gutter_None, Gutter_Base, Gutter_XXL, Gutter_L, Gutter_S
- **Entities.BreakColumns**: All, None, First, Middle, Last

## Placeholders

- **Column1**: Drag your content to this placeholder.
- **Column2**: Drag your content to this placeholder.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ColumnsMediumRight1","source":"IWebBlock:ColumnsMediumRight","as":"$b"}
{"op":"create","parent":"$b/Column1","type":"IExpressionWidget","as":"$eColumn1"}
{"op":"create","parent":"$b/Column2","type":"IExpressionWidget","as":"$eColumn2"}
```

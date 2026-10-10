# Website_Section

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 2 widgets internos

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Transparent | Set the color. |
| Padding | Space Identifier | nao | Entities.Space.Medium | Set the padding top and bottom value. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.Space**: Medium, ExtraSmall, None, XXLarge, Base, Small, Large, ExtraLarge

## Placeholders

- **Content**

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Website_Section1","source":"IWebBlock:Website_Section","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```

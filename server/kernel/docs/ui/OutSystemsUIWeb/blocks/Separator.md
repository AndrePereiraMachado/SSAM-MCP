# Separator

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Utilities** | publico | 1 widgets internos

Allows to split information with a horizontal or vertical line.

To use the vertical separator, the parent element needs to have a defined height.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Neutral4 | Set the color. |
| Space | Space Identifier | nao | Entities.Space.Base | Set the space around the Separator line. |
| IsVertical | Boolean | nao | False | If set as true, then the Separator becomes vertical. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.Space**: Medium, ExtraSmall, None, XXLarge, Base, Small, Large, ExtraLarge

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Separator1","source":"IWebBlock:Separator","as":"$b"}
```

# CardSectioned

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 6 widgets internos

Card with placeholders for Title, Content and Footer. Title and Footer placeholders are not displayed if they are empty.

A card sectioned is useful for a few short, related pieces of information. It roughly resembles a playing card in size and shape, and is intended as a linked, short representation of a conceptual unit.

Place your content in the placeholders, Use the parameters to define the orientation, direction and if the Title has padding.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Orientation | Orientation Identifier | nao | Entities.Orientation.Vertical | Set the orientation of the card. |
| ImagePadding | Boolean | nao | True | When true, content has 24px of padding. |
| IsRight | Boolean | nao | False | Aligns content to the right. This will only go into effect if the Orientation parameter is set to Horizontal. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

- **Image**: Drag an image, GIF or video to this placeholder. (em `CardSectionedWrapper`)
- **Title**: Use this placeholder to set your title. (em `CardSectionedWrapper`)
- **Content**: Drag your content to this placeholder. (em `CardSectionedWrapper`)
- **Footer**: Use this placeholder to set your footer. (em `CardSectionedWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"CardSectioned1","source":"IWebBlock:CardSectioned","as":"$b"}
{"op":"create","parent":"$b/Image","type":"IExpressionWidget","as":"$eImage"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
```

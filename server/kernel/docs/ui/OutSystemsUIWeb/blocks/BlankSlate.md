# BlankSlate

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 6 widgets internos

A simple box to be presented as an empty state to the user and providing direction. 

Works great for a user onboarding or displaying the empty state of lists or detail screens.

Write the message on the placeholder Content. You may also set the Position type in the Block properties.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | PositionExtended Identifier | nao | Entities.PositionExtended.Center | Set the position around the widget element. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.PositionExtended**: TopLeft, TopRight, TopCenter, BottomRight, Center, CenterLeft, CenterRight, BottomCenter, BottomLeft

## Placeholders

- **Content**: Drag your content to this placeholder. (em `BlankSlateWrapper`) | nasce com: Container, Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"BlankSlate1","source":"IWebBlock:BlankSlate","empty":true,"as":"$b"}
```

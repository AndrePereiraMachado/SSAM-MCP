# TimelineItem

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 7 widgets internos

Item to create a timeline of event information, with placeholders for icon, title text and dates.

Used to create a sequence of chronologically related events.

Drag the pattern to the Timeline Content placeholder. Drag the necessary content to the placeholders. Use the Color parameter to define the color of the icon.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Color | Color Identifier | nao | Entities.Color.Primary | Background color of the icon. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9

## Placeholders

- **Icon**: Drag the Icon widget to this placeholder. (em `TimelineWrapper`)
- **Date**: Drag your content to this placeholder. (em `TimelineWrapper`)
- **Content**: Drag your content to this placeholder. (em `TimelineWrapper`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"TimelineItem1","source":"IWebBlock:TimelineItem","as":"$b"}
{"op":"create","parent":"$b/Icon","type":"IExpressionWidget","as":"$eIcon"}
{"op":"create","parent":"$b/Date","type":"IExpressionWidget","as":"$eDate"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```

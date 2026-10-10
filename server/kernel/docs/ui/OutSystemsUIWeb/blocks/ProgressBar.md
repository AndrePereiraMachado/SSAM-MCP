# ProgressBar

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Numbers** | publico | 8 widgets internos

Progress bar with indication of a current action in percentage values.

Configure the variable that defines the percentage. You can also change the shape, size, orientation and color of the ProgressBar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Percentage | Integer | nao | 50 | Percentage to display, you can use functions or local variables. |
| Color | Color Identifier | nao | Entities.Color.Primary | Set the background color. |
| Shape | Shape Identifier | nao | Entities.Shape.Rounded | Set the shape. |
| Size | ProgressBarSize Identifier | nao | Entities.ProgressBarSize.Base | Set the size. |
| IsInline | Boolean | nao | False | Set the orientation of the value placeholder.   When true, the value placeholder will be placed at the end of the line and the label placeholder is hidden.  When False, value and label of the placeholder will be placed over the line. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.Color**: Yellow, Neutral0, Indigo, Neutral7, Neutral8, Primary, Grape, Neutral10, Blue, Orange, Green, Lime, Neutral5, Secondary, Neutral6, Violet, Cyan, Pink, Red, Neutral1, Teal, Neutral3, Neutral4, Neutral2, Transparent, Neutral9
- **Entities.Shape**: Rounded, Sharp, SoftRounded
- **Entities.ProgressBarSize**: Base, ExtraSmall, Small

## Placeholders

- **Title**: Use this placeholder to set your title. (em `ProgressBarWrapper`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Value**: Drag your content to this placeholder. (em `ProgressBarWrapper`) | nasce com: Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ProgressBar1","source":"IWebBlock:ProgressBar","empty":true,"as":"$b"}
```

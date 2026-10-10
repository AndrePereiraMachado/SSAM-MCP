# DEPRECATED_Columns2

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 3 widgets internos

Split content in multiple columns.

Configure the behavior in the input parameters to define how columns will stack in different devices.

Ideal to improve the way information is displayed fits different devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| UseGutter | Boolean | nao | True | Creates a space between columns |
| PhonePortraitBreak | ColumnBreak Identifier | nao | Entities.ColumnBreak.BreakNone | Behavior of the columns in a Phone with Portrait orientation |
| PhoneLandscapeBreak | ColumnBreak Identifier | nao | Entities.ColumnBreak.BreakNone | Behavior of the columns in a Phone with Landscape orientation |
| TabletPortraitBreak | ColumnBreak Identifier | nao | Entities.ColumnBreak.BreakNone | Behavior of the columns in a Tablet with Portrait orientation |
| TabletLandscapeBreak | ColumnBreak Identifier | nao | Entities.ColumnBreak.BreakNone | Behavior of the columns in a Tablet with Landscape orientation |

Valores possiveis (static entities):

- **Entities.ColumnBreak**: BreakFirst, BreakNone, BreakLast, BreakAll, BreakMiddle

## Placeholders

- **Column1**: Column 1 (em `content`)
- **Column2**: Column 2 (em `content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Columns21","source":"IMobileBlock:DEPRECATED_Columns2","as":"$b"}
{"op":"create","parent":"$b/Column1","type":"IExpression","as":"$eColumn1"}
{"op":"create","parent":"$b/Column2","type":"IExpression","as":"$eColumn2"}
```

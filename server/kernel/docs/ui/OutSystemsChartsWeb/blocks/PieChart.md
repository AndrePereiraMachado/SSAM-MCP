# PieChart

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Charts** | publico | 6 widgets internos

Pie charts illustrate proportions of values.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SourceDataPointList | DataPoint Record List | sim |  | The list of all data points to be plotted on the chart. |
| Height | Integer | nao | 300 | The vertical size of the chart in pixels (300 by default).  The horizontal size of the chart is the parent’s width. |
| LegendPosition | LegendPosition Identifier | nao | Entities.LegendPosition.Bottom | The position where the legend is displayed on the chart (‘Bottom’ by default). |
| ChartFormat | ChartFormat Record | nao |  | Formatting options for the chart. Action ChartFormat_Init helps to create and initialize this parameter. |
| Clickable | Boolean | nao | False | Set to True to allow clicking on plotted values and execute the On Click action (False by default). |
| AdvancedFormat | AdvancedFormat Record | nao |  | Highcharts JSON to format elements displayed on the chart. Action AdvancedOptions_Init helps to create and initialize this parameter. |

Valores possiveis (static entities):

- **Entities.LegendPosition**: Bottom, Hidden, Inside, Top, Left, Right

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: PieChart_HighCharts
- Actions do bloco: AllowOnClick
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"PieChart1","source":"IWebBlock:PieChart","as":"$b"}
{"op":"set","target":"$b/SourceDataPointList","prop":"Value","value":"<DataPoint Record List>"}
```

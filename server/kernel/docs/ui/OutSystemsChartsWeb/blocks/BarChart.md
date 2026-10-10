# BarChart

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Charts** | publico | 6 widgets internos

Bar charts compare multiple values using horizontal bars. 
In this chart, the X-axis runs vertically and the Y-axis runs horizontally.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SourceDataPointList | DataPoint Record List | sim |  | The list of all data points to be plotted on the chart. |
| StackingType | StackingType Identifier | nao | Entities.StackingType.NoStacking | The way to plot multiple data series on the chart:     - ‘NoStacking’: plot data series side by side to compare them;     - ‘Stacked’: plot data series stacked to show their contribution to a total;     - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.  ‘NoStacking’ is the default option. |
| Height | Integer | nao | 300 | The vertical size of the chart in pixels (300 by default).  The horizontal size of the chart is the parent’s width. |
| LegendPosition | LegendPosition Identifier | nao | Entities.LegendPosition.Bottom | The position where the legend is displayed on the chart (‘Bottom’ by default). The legend is hidden if no series name is set in any data point. |
| XAxisFormat | XAxisFormat Record | nao |  | Formatting options for the X-axis. Action XAxisFormat_Init helps to create and initialize this parameter. |
| YAxisFormat | YAxisFormat Record | nao |  | Formatting options for the Y-axis. Action YAxisFormat_Init helps to create and initialize this parameter. |
| ChartFormat | ChartFormat Record | nao |  | Formatting options for the chart. Action ChartFormat_Init helps to create and initialize this parameter. |
| Clickable | Boolean | nao | False | Set to True to allow clicking on plotted values and execute the On Click action (False by default). |
| AdvancedFormat | AdvancedFormat Record | nao |  | Highcharts JSON to format elements displayed on the chart. Action AdvancedOptions_Init helps to create and initialize this parameter. |

Valores possiveis (static entities):

- **Entities.StackingType**: Stacked, Stacked100Percent, NoStacking
- **Entities.LegendPosition**: Bottom, Hidden, Inside, Top, Left, Right

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: BarColumnChart_HighCharts
- Actions do bloco: AllowOnClick
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"BarChart1","source":"IWebBlock:BarChart","as":"$b"}
{"op":"set","target":"$b/SourceDataPointList","prop":"Value","value":"<DataPoint Record List>"}
```

# LineAreaChart_HighCharts

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Internal** | privado | 6 widgets internos

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ChartType | InternalChartType Identifier | sim |  |  |
| ChartWidgetId | Text | sim |  |  |
| DataPointList | DataPoint Record List | sim |  | Data to display. |
| Stacking | StackingType Identifier | sim |  | Whether and how to stack the areas of each series on top of each other. - None: No stacking, multiple series appear overlapped. - Stacked: Stack areas of each series on top of each other. - Stacked100Percent: Stack areas of each series on top of each other and fill 100% of the Y axis. |
| CategoryAxis | XAxisFormat Record | sim |  | Category Axis customization. Use the CreateXAxis action to create this. |
| ValueAxis | YAxisFormat Record | sim |  | Value Axis customization. Use the CreateYAxis action to create this. |
| Legend | LegendPosition Identifier | sim |  | The chart legend to show the series' names, colors or symbols. Use the CreateLegend action to create a customization for the chart legend. |
| Options | ChartFormat Record | sim |  | Chart's options. E.g.: "chart: { backgroundColor: '#EEEEEE'}" - to set the background color to a light gray. "plotOptions: { series: { animation: true } }" - to enable the initial animation when the chart is displayed  All customizations available in: http://api.highcharts.com/highcharts |
| AdvancedOptions | AdvancedFormat Record | sim |  | Customizations to apply to the data item in JSON format. Separate multiple customizations with commas. E.g.: "dataLabels: { enabled: true, formatter: function () { return 'top value' } }" - to show a custom data label in this point (for Line and Area charts only). "marker: { radius: 7, states: { hover: { radius: 10 } } }" - to show a large marker in this point.  All customizations available in: http://api.highcharts.com/highcharts#series.data |
| Height | Integer | sim |  |  |
| IsClickable | Boolean | nao | False |  |

Valores possiveis (static entities):

- **Entities.InternalChartType**: Column, Bar, Area, Pie, Line
- **Entities.StackingType**: Stacked, Stacked100Percent, NoStacking
- **Entities.LegendPosition**: Bottom, Hidden, Inside, Top, Left, Right

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: OSHighCharts, JavaScript_Content
- Chama actions do modulo: GetHighChartsJSON (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LineAreaChart_HighCharts1","source":"IWebBlock:LineAreaChart_HighCharts","as":"$b"}
{"op":"set","target":"$b/ChartType","prop":"Value","value":"<InternalChartType Identifier>"}
{"op":"set","target":"$b/ChartWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/DataPointList","prop":"Value","value":"<DataPoint Record List>"}
{"op":"set","target":"$b/Stacking","prop":"Value","value":"<StackingType Identifier>"}
{"op":"set","target":"$b/CategoryAxis","prop":"Value","value":"<XAxisFormat Record>"}
{"op":"set","target":"$b/ValueAxis","prop":"Value","value":"<YAxisFormat Record>"}
```

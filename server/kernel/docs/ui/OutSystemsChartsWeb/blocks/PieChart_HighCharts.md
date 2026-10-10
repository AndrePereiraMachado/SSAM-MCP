# PieChart_HighCharts

OutSystemsChartsWeb 2.0.0 | Traditional | UI flow **Internal** | privado | 6 widgets internos

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Data | DataPoint Record List | sim |  |  |
| Legend | LegendPosition Identifier | sim |  | The chart legend to show the series' names, colors or symbols. Use the CreateLegend action to create a customization for the chart legend. |
| ChartWidgetId | Text | sim |  |  |
| Options | ChartFormat Record | sim |  | Chart's options. E.g.: "chart: { backgroundColor: '#EEEEEE'}" - to set the background color to a light gray. "plotOptions: { series: { animation: true } }" - to enable the initial animation when the chart is displayed  All customizations available in: http://api.highcharts.com/highcharts |
| AdvancedOptions | AdvancedFormat Record | sim |  | Customizations to apply to the data item in JSON format. Separate multiple customizations with commas. E.g.: "dataLabels: { enabled: true, formatter: function () { return 'top value' } }" - to show a custom data label in this point (for Line and Area charts only). "marker: { radius: 7, states: { hover: { radius: 10 } } }" - to show a large marker in this point.  All customizations available in: http://api.highcharts.com/highcharts#series.data |
| Height | Integer | sim |  |  |
| IsClickable | Boolean | nao | False |  |

Valores possiveis (static entities):

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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"PieChart_HighCharts1","source":"IWebBlock:PieChart_HighCharts","as":"$b"}
{"op":"set","target":"$b/Data","prop":"Value","value":"<DataPoint Record List>"}
{"op":"set","target":"$b/Legend","prop":"Value","value":"<LegendPosition Identifier>"}
{"op":"set","target":"$b/ChartWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/Options","prop":"Value","value":"<ChartFormat Record>"}
{"op":"set","target":"$b/AdvancedOptions","prop":"Value","value":"<AdvancedFormat Record>"}
{"op":"set","target":"$b/Height","prop":"Value","value":"<Integer>"}
```

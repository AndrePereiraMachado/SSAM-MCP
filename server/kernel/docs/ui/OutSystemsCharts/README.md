# OutSystemsCharts 3.10.0 (ReactiveLibrary)

Gerado em 2026-09-04T09:44:35 de `OutSystemsCharts.oml` pelo `anvil ui-catalog`. Nao editar a mao: regenerar quando a versao do ambiente mudar.

22 blocos (19 publicos), 17 static entities de configuracao, 11 actions publicas, 52 scripts, 1 temas.

## Como instanciar um bloco com os verbos

O modulo alvo precisa referenciar a biblioteca (`references`). Um bloco entra na tela como block instance:

```json
{"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IMobileBlockInstanceWidget","name":"Accordion1","source":"IMobileBlock:Accordion","empty":true,"as":"$acc"}
// source = SourceBlock na criacao; empty = apaga o conteudo de exemplo dos placeholders (nasce ao definir o SourceBlock)
{"op":"set","target":"$acc/MultipleItems","prop":"Value","value":"True"}          // input -> IArgument.Value
{"op":"create","parent":"$acc/Content","type":"IContainer","name":"Inner"}      // placeholder por nome
```

Widgets nativos do Reactive/Mobile: IContainer, IExpression, IInput, IButton, ILink, IList, IListItem, ITableRecords, IDropdown, ICheckbox, ISwitch, IIcon, IImage, IForm (plugin NRWidgets). Leia a pagina do bloco antes de usar: placeholders esperam filhos especificos e eventos obrigatorios precisam de handler (secao 'Como ligar um evento' da pagina).

## Addons (5)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ChartExport](blocks/ChartExport.md) | sim | Chart addon used to add the exporting functionality to the chart. | 4 |  |  |
| [ChartLegend](blocks/ChartLegend.md) | sim | Chart addon used to customize the box containing a symbol and a name for each series or data point in the chart. | 6 |  |  |
| [ChartSeriesStyling](blocks/ChartSeriesStyling.md) | sim | Chart addon used to customize the styling of the chart series. | 7 |  |  |
| [ChartXAxis](blocks/ChartXAxis.md) | sim | Chart addon used to customize the horizontal axis of the chart, though if the chart is inverted this is the vertical axis (e.g. | 9 |  |  |
| [ChartYAxis](blocks/ChartYAxis.md) | sim | Chart addon used to customize the vertical axis of the chart, though if the chart is inverted this is the horizontal axis (e.g. | 9 |  |  |

## Advanced (1)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [HighchartsModules](blocks/HighchartsModules.md) | sim | Extends charts by adding additional Highcharts scripts to the page. | 1 |  | Loaded, LoadError |

## Charts (7)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AreaChart](blocks/AreaChart.md) | sim | The area chart is composed of data points plotted and connected by a line with a colored area below the line. | 7 | AddOns_Placeholder | Initialized, OnDataPointClick |
| [BarChart](blocks/BarChart.md) | sim | The bar chart is a two-dimensional chart where rectangular bars are placed along the x axis with bar length representing the value for a specific category. | 6 | AddOns_Placeholder | Initialized, OnDataPointClick |
| [ColumnChart](blocks/ColumnChart.md) | sim | The column chart is a two-dimensional chart where rectangular bars are placed along the y axis with bar height representing the value for a specific category. | 6 | AddOns_Placeholder | Initialized, OnDataPointClick |
| [DonutChart](blocks/DonutChart.md) | sim | The donut chart is a circular graph that displays data in rings, where each ring represents a category and the size of the ring corresponds to the value of t... | 5 | AddOns_Placeholder | OnDataPointClick, Initialized |
| [LineChart](blocks/LineChart.md) | sim | The line chart is a two-dimensional chart where each point represents a single value and is connected by a line. | 6 | AddOns_Placeholder | Initialized, OnDataPointClick |
| [PieChart](blocks/PieChart.md) | sim | The pie chart is a circular graph that displays data in sections, where each section represents a category and the size of the section corresponds to the val... | 4 | AddOns_Placeholder | OnDataPointClick, Initialized |
| [RadarChart](blocks/RadarChart.md) | sim | The radar chart, also known as Polar Chart, illustrate multivariate data in a two-dimensional chart, plotted along radial axis. | 5 | AddOns_Placeholder | OnDataPointClick, Initialized |

## Styles (3)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [ChartCSS](blocks/ChartCSS.md) | nao |  | 0 |  |  |
| [ImagesCSS](blocks/ImagesCSS.md) | nao |  | 0 |  |  |
| [LoadingCSS](blocks/LoadingCSS.md) | nao |  | 0 |  |  |

## Version1 (6)

| Bloco | Publico | Descricao | Inputs | Placeholders | Eventos |
|---|---|---|---|---|---|
| [AreaChart_v1](blocks/AreaChart_v1.md) | sim | Area charts illustrate the contribution of values to a total over time. | 9 |  | OnClick |
| [BarChart_v1](blocks/BarChart_v1.md) | sim | Bar charts compare multiple values using horizontal bars. | 9 |  | OnClick |
| [ColumnChart_v1](blocks/ColumnChart_v1.md) | sim | Column charts compare multiple values using vertical bars. | 9 |  | OnClick |
| [DonutChart_v1](blocks/DonutChart_v1.md) | sim | Donut charts illustrate proportions of values. | 6 |  | OnClick |
| [LineChart_v1](blocks/LineChart_v1.md) | sim | Line charts illustrate trends of values over time. | 8 |  | OnClick |
| [PieChart_v1](blocks/PieChart_v1.md) | sim | Pie charts illustrate proportions of values. | 6 |  | OnClick |

Veja tambem: [config-values.md](config-values.md) (static entities), [actions.md](actions.md) (actions publicas), [themes.md](themes.md) (tokens CSS).

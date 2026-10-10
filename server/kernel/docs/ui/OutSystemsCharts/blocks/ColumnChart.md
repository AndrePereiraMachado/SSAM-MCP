# ColumnChart

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Charts** | publico | 26 widgets internos

The column chart is a two-dimensional chart where rectangular bars are placed along the y axis with bar height representing the value for a specific category.
To customize the elements of the chart (X axis, Y axis, Series Legend, Series, or Tooltip) drag-and-drop the addons into the ChartAddons placeholder inside the Chart block. 
Note: the addons SS preview won't be visible in runtime.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DataPointList | DataPoint List | sim |  | Data that will be used in the chart. Create an aggregate with your data and use it in this field to populate the chart.  Structure: - Value (Decimal) Mandatory - The value to be plotted. - Label (Text) Mandatory - The label of the data point. - SeriesName (Text) - The name of the series where the data point belongs. - Color (Text) - The color of the data point. By default, the chart will be presented with the OutSystems data visualization color palette. To define a custom color for a series, use the Color property of the ChartSeriesStyling block. - Tooltip (Text) - The text that will be displayed on the tooltip of the data point. By default, the tooltip contains the label and value of the point, following the structure [Label]: [Value]. Example: "Apples: 58" |
| Height | Text | nao | "300px" | Set the vertical size, in px or %, of the chart. By default, the vertical size is 300px. |
| StackingType | StackingType Identifier | nao |  | The way to plot multiple data series on the chart:  - ‘NoStacking’: plot data series side by side to compare them;  - ‘Stacked’: plot data series stacked to show their contribution to a total;  - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.   ‘NoStacking’ is the default option. |
| ValuesType | ValuesType Identifier | nao | Entities.ValuesType.Text | Set how the chart labels are handled to be displayed on the chart. The type of the values can be:  - Integer: the labels will be displayed as integer numbers.  - Decimal: the labels will be displayed as decimal numbers.  - Datetime: the labels will be displayed as datetimes.  - Text: the labels will be displayed as text and treated as categories. By default, the type is Text. |
| OptionalConfigs | OptionalConfigs | nao |  | Set additional parameters to customize the column chart behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied. |

Valores possiveis (static entities):

- **Entities.StackingType**: NoStacking, Stacked100Percent, Stacked
- **Entities.ValuesType**: Datetime, Decimal, Text, Integer

## Placeholders

- **AddOns_Placeholder**: To customize your chart, drag addons (ChartXAxis, ChartYAxis, ChartSeriesStyling,..) to this section. 
This section will not be displayed in runtime. (em `content/content`) | nasce com: WebBlockInstance:ChartXAxis, WebBlockInstance:ChartYAxis, WebBlockInstance:ChartLegend, WebBlockInstance:ChartSeriesStyling (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(ChartWidgetId: Text): Event triggered after the chart instance is ready.
- **OnDataPointClick**(ChartWidgetId: Text, DataPoint: DataPoint): Event triggered when the chart’s data is clicked. It returns information about the chart and data point that was clicked.

## Composicao interna

- Usa os blocos: ChartXAxis, ChartYAxis, ChartLegend, ChartSeriesStyling, LoadingCSS, ImagesCSS, ChartCSS
- Scripts exigidos: Highcharts, HighchartsMore, Highcharts3d, Accessibility, HighchartsNoDataToDisplay, OutsystemsCharts
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> GenerateChart; OnDestroy -> OnDestroy
- Actions do bloco: OnDataPointClickHandler, SubscribeEvent, OnInitialize, GenerateChart, OnParametersChanged, UnsubscribeEvents, OnDestroy, OnChartInitializeHandler
- Chama actions do modulo: ChartEventSubscribe, GenerateUniqueId, CreateChart, InitChart, UpdateConfigs, ChartEventUnsubscribe, RemoveChart (contratos em [actions.md](../actions.md))

## JavaScript

`SubscribeEvent` / no `GetCallbackHandler`:

```js
$parameters.ChartInitialized_Callback = $actions.OnChartInitializeHandler;
$parameters.DataPointClick_Callback = $actions.OnDataPointClickHandler;
```

`UnsubscribeEvents` / no `GetActionsHandler`:

```js
$parameters.ChartInitialized_Callback = $actions.OnChartInitializeHandler;
$parameters.ChartDataPointClick_Callback = $actions.OnDataPointClickHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ColumnChart1","source":"IMobileBlock:ColumnChart","empty":true,"as":"$b"}
{"op":"set","target":"$b/DataPointList","prop":"Value","value":"<DataPoint List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ColumnChart1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ChartWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/ChartWidgetId","prop":"Value","value":"ChartWidgetId"}
```

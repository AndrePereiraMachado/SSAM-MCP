# ColumnChart_v1

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Version1** | publico | 7 widgets internos

Column charts compare multiple values using vertical bars.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SourceDataPointList | Legacy_DataPoint List | sim |  | The list of all data points to be plotted on the chart. |
| StackingType | StackingType_v1 Identifier | nao | Entities.StackingType_v1.NoStacking | The way to plot multiple data series on the chart:     - ‘NoStacking’: plot data series side by side to compare them;     - ‘Stacked’: plot data series stacked to show their contribution to a total;     - ‘Stacked100Percent’: plot data series stacked to show their percentage in a total.  ‘NoStacking’ is the default option. |
| Height | Integer | nao | 300 | The vertical size of the chart in pixels (300 by default). |
| LegendPositionId | LegendPosition_v1 Identifier | nao |  | The position where the legend is displayed on the chart (‘Bottom’ by default). |
| XAxisFormat | Legacy_XAxisFormat | nao |  | Formatting options for the X-axis using Highcharts JSON. Action XAxisFormat_Init helps to create and initialize this parameter.  To be compliant with Content Security Policy (CSP) requirements, the support for the eval() function will be discontinued. Consequently, this parameter will be impacted and may not function as expected. It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.  Additionally, for these non-deprecated parameters, as an alternative we recommend the use of Charts v2. |
| YAxisFormat | Legacy_YAxisFormat | nao |  | Formatting options for the Y-axis using Highcharts JSON. Action YAxisFormat_Init helps to create and initialize this parameter.  To be compliant with Content Security Policy (CSP) requirements, the support for the eval() function will be discontinued. Consequently, this parameter will be impacted and may not function as expected. It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.  Additionally, for these non-deprecated parameters, as an alternative we recommend the use of Charts v2. |
| ChartFormat | Legacy_ChartFormat | nao |  | Formatting options for the Chart using Highcharts JSON.  To be compliant with Content Security Policy (CSP) requirements, the support for the eval() function will be discontinued. Consequently, this parameter will be impacted and may not function as expected. It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.  Additionally, for these non-deprecated parameters, as an alternative we recommend the use of Charts v2. |
| Clickable | Boolean | nao | False | Set to True to allow clicking on plotted values and execute the On Click action (False by default). |
| AdvancedFormat | Legacy_AdvancedFormat | nao |  | Information to format chart elements using Highcharts JSON.  To be compliant with Content Security Policy (CSP) requirements, the support for the eval() function will be discontinued. Consequently, this parameter will be impacted and may not function as expected. It's important to note that this change will only affect those who need to ensure compliance with CSP guidelines.  Additionally, for these non-deprecated parameters, as an alternative we recommend the use of Charts v2. |

Valores possiveis (static entities):

- **Entities.StackingType_v1**: Stacked, Stacked100Percent, NoStacking
- **Entities.LegendPosition_v1**: Top, Right, Left, Hidden, Inside, Bottom

## Placeholders

Nenhum.

## Eventos

- **OnClick**(DataPoint: Legacy_DataPoint)

## Composicao interna

- Scripts exigidos: Highcharts, HighchartsMore, Highcharts3d, Accessibility, OutsystemsCharts
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> GenerateChart; OnDestroy -> OnDestroy
- Actions do bloco: DataClicked, OnParametersChanged, OnDestroy, UnsubscribeEvents, GenerateChart, OnInitialize
- Chama actions do modulo: UpdateConfigs, RemoveChart, SeriesEventUnsubscribe, Legacy_InitChart, SeriesEventSubscribe, GenerateUniqueId, CreateChart (contratos em [actions.md](../actions.md))

## JavaScript

`UnsubscribeEvents` / no `GetActionsHandler`:

```js
$parameters.CallbackEvent = $actions.DataClicked
```

`GenerateChart` / no `ShowEmptyState`:

```js
OutSystems.ChartAPI.Chart.ShowEmptyState(
$parameters.containerId
);
```

`GenerateChart` / no `GetActionsHandler`:

```js
$parameters.CallbackEvent = $actions.DataClicked
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ColumnChart_v11","source":"IMobileBlock:ColumnChart_v1","as":"$b"}
{"op":"set","target":"$b/SourceDataPointList","prop":"Value","value":"<Legacy_DataPoint List>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ColumnChart_v11_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DataPoint","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Legacy_DataPoint"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnClick/DataPoint","prop":"Value","value":"DataPoint"}
```

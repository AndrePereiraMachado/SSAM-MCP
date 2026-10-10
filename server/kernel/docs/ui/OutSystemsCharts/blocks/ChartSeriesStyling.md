# ChartSeriesStyling

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Addons** | publico | 9 widgets internos

Chart addon used to customize the styling of the chart series. You can bind it to a specific series (by setting the SeriesName) or apply the styles to all of them (by leaving the SeriesName empty). 
Drag-and-drop to the chart Addons placeholder to customize the series styling. 
When removed from the Addons placeholder, the styling customizations will be removed.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SeriesName | Text | nao |  | Set the name of the series to be displayed from your data. The name should match one of the series from the DataPointList.SeriesName. Example: If you have three series: "Installation", "Manufactoring", "Sales & Distribuition", to customize the series "Installation", set the parameter as "Installation". |
| SeriesType | SeriesType Identifier | nao |  | Set the type of series, (e.g. line or column). By default, the series type is inherited from chart. Use this property when the chart is a combination of series types. Otherwise, there is no need to set it on the series level. |
| Marker | SeriesStylingMarker | nao |  | Customize the visual appearance of the data point markers. Markers are the symbols used to represent the data points. |
| ShowDataPointValues | Boolean | nao | False | Set to True to see markers on the chart points. By default, the markers are hidden when the data is dense, and shown for more widespread data points. |
| Styling | SeriesStyling | nao |  | Define the styles for a given series of the chart. |
| OptionalConfigs | SeriesStylingOptionalConfigs | nao |  | Define the optional styles for chart series. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied. |

Valores possiveis (static entities):

- **Entities.SeriesType**: Bar, LineSpline, AreaSpline, Area, Pie, Line, Column

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnParametersChanged, OnDestroy, OnInitialize
- Chama actions do modulo: InitializeSeriesStyling, UpdateSeriesStyling, DestroySeriesStyling, CreateSeriesStyling, GenerateUniqueId (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartSeriesStyling1","source":"IMobileBlock:ChartSeriesStyling","as":"$b"}
```

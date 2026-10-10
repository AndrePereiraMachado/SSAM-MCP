# ChartYAxis

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Addons** | publico | 10 widgets internos

Chart addon used to customize the vertical axis of the chart, though if the chart is inverted this is the horizontal axis (e.g. Bar Chart).
Drag-and-drop to the chart Addons placeholder to customize the y axis. 
When removed from the Addons placeholder, the y axis element will not appear in runtime. 
Note: This block can't be used for the Pie and Donut charts.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | nao |  | The axis title, showing next to the axis line. By default, the axis does not have a title. |
| Visible | Boolean | nao | True | Set to True to display the Y axis and its elements on the chart. False, otherwise.  By default, the Y axis is visible. |
| MinValue | Decimal | nao |  | The minimum value of the axis.  By default, the MinValue is automatically calculated. |
| MaxValue | Decimal | nao |  | The maximum value of the axis.  By default, the MaxValue is automatically calculated. |
| Label | AxisLabel | nao |  | Customize the labels that show the data for each tick on the Y axis. |
| Styling | YAxisStyling | nao |  | Define the styles for the Y axis of the chart. |
| GridLines | YAxisGridLinesStyling | nao |  | Define the styles for the horizontal lines of the chart. |
| OptionalConfigs | YAxisOptionalConfigs | nao |  | Set additional parameters to customize the YAxis behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnParametersChanged, OnReady, OnInitialize
- Chama actions do modulo: DestroyAxis, UpdateAxisConfigs, InitializeAxis, GenerateUniqueId, CreateAxis (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartYAxis1","source":"IMobileBlock:ChartYAxis","as":"$b"}
```

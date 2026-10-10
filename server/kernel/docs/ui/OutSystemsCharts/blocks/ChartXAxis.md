# ChartXAxis

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Addons** | publico | 10 widgets internos

Chart addon used to customize the horizontal axis of the chart, though if the chart is inverted this is the vertical axis (e.g. Bar Chart).
Drag-and-drop to the chart Addons placeholder to customize the x axis. 
When removed from the Addons placeholder, the x axis element will not appear in runtime. 
Note: This block can't be used for the Pie and Donut charts.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | nao |  | The axis title, showing next to the axis line. By default, the axis does not have a title. |
| Visible | Boolean | nao | True | Set to True to display the X axis and its elements on the chart. False, otherwise.  By default, the X axis is visible. |
| MinValue | Decimal | nao |  | The minimum value of the axis.  By default, the MinValue is automatically calculated. |
| MaxValue | Decimal | nao |  | The maximum value of the axis.  By default, the MaxValue is automatically calculated. |
| Label | AxisLabel | nao |  | Customize the labels that show the data for each tick on the X axis. |
| Styling | XAxisStyling | nao |  | Define the styles for the X axis of the chart. |
| GridLines | XAxisGridLinesStyling | nao |  | Define the styles for the vertical lines of the chart. |
| OptionalConfigs | XAxisOptionalConfigs | nao |  | Set additional parameters to customize the XAxis behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnReady, OnDestroy, OnInitialize
- Chama actions do modulo: UpdateAxisConfigs, InitializeAxis, DestroyAxis, CreateAxis, GenerateUniqueId (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartXAxis1","source":"IMobileBlock:ChartXAxis","as":"$b"}
```

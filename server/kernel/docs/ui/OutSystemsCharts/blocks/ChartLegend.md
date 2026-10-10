# ChartLegend

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Addons** | publico | 10 widgets internos

Chart addon used to customize the box containing a symbol and a name for each series or data point in the chart. 
Drag-and-drop to the chart Addons placeholder to customize the series legend. 
When removed from the Addons placeholder, the legend element will not appear in runtime.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Visible | Boolean | nao | True | Set to True to display the legend on the chart. False, otherwise.  By default, the chart legend is visible. |
| Position | LegendPosition Identifier | nao | Entities.LegendPosition.Bottom | Set the Legend's position (Default: Bottom). The predefined options are:  -Bottom  -BottomLeft  -BottomRight  -Center  -Left  -Right  -Top  -TopLeft  -TopRight  Examples:  - Entities.Position.Right - The Legend is displayed to the right of the chart.  - Entities.Position.Bottom - The Legend is displayed underneath the chart. |
| Layout | LegendLayout Identifier | nao | Entities.LegendLayout.Horizontal | Set the layout of the legend items. The layout of the legend can be:  - Horizontal - Vertical - Proximate: the legend items will be placed as close as possible to the graphs they're representing, except in inverted charts or when the legend position doesn't allow it. Since the Position is calculated based on the charts series, the legend with this layout can only be placed in three positions (center, left, right).   By default, the legend layout is horizontal.  Note: updates to the parameter value after the chart has been draw will not be reflected in runtime. |
| Styling | ChartLegendStyling | nao |  | Define the styles for the legend of the chart. |
| OptionalConfigs | ChartLegendOptionalConfigs | nao |  | Set additional parameters to customize the chart series legend behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS.  Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied. |

Valores possiveis (static entities):

- **Entities.LegendPosition**: Top, TopRight, BottomLeft, Bottom, BottomRight, Right, Center, Left, TopLeft
- **Entities.LegendLayout**: Horizontal, Proximate, Vertical

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnDestroy, OnInitialize, OnParametersChanged
- Chama actions do modulo: InitializeLegend, DestroyLegend, GenerateUniqueId, CreateLegend, UpdateLegendConfigs (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartLegend1","source":"IMobileBlock:ChartLegend","as":"$b"}
```

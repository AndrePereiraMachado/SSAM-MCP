# ChartExport

OutSystemsCharts 3.10.0 | Reactive/Mobile | UI flow **Addons** | publico | 10 widgets internos

Chart addon used to add the exporting functionality to the chart. It allows users to: View the chart in full screen, print, download as png, jpeg, pdf,svg, csv and xls. 
Drag-and-drop to the chart Addons placeholder to add exporting options to the chart.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| FileName | Text | nao | "chart" | The name of the exported file without extension. By default, the file name is "chart". |
| MenuOptions | ChartExportMenuOptions | nao |  | Set to True to display this option on the exporting menu. Set to False to hide it. By default, True. |
| OptionalConfigs | ChartExportOptionalConfigs | nao |  | Define the optional styles for chart export. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS.  Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Scripts exigidos: Exporting, ExportData
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnDestroy, OnParametersChanged, OnReady
- Chama actions do modulo: GenerateUniqueId, CreateExport, DestroyExport, UpdateExportConfigs, InitializeExport (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ChartExport1","source":"IMobileBlock:ChartExport","as":"$b"}
```

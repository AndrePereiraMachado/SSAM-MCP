# HeatmapLayer

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **HeatmapLayer** | publico | 3 widgets internos

The Heatmap Layer block allows to visualize spatial distribution of data on maps. 
To use it, drag-and-drop the block inside the map Addons_Placeholder.

📝 The Heatmap Layer is only available for Google Maps.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Points | Points List | sim |  | List of heatmap data points. |
| OptionalConfigs | OptionalHeatmapLayerConfigs | nao |  | Set additional parameters to customize the heatmap layer behavior and functionality. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Scripts exigidos: deckgl_bundle
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnInitialize, OnParametersChanged, OnDestroy
- Chama actions do modulo: CreateHeatmapLayer, GetHashcode, GenerateUniqueId, LogEvent, ChangeHeatmapLayerOpacity, ChangeHeatmapLayerPoints, ChangeHeatmapLayerMinIntensity, ChangeHeatmapLayerRadius, ChangeHeatmapLayerGradient, ChangeHeatmapLayerMaxIntensity, RemoveHeatmapLayer (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"HeatmapLayer1","source":"IMobileBlock:HeatmapLayer","as":"$b"}
{"op":"set","target":"$b/Points","prop":"Value","value":"<Points List>"}
```

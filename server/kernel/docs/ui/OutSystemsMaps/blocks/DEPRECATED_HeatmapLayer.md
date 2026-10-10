# DEPRECATED_HeatmapLayer

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **HeatmapLayer** | publico | 3 widgets internos

DEPRECATED due to Google Maps upcomming decommission: https://developers.google.com/maps/deprecations#heatmap-layer-js-deprecation;

📝 The Heatmap Layer is only available for Google Maps.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Points | Points List | sim |  | List of heatmap data points. |
| OptionalConfigs | DEPRECATED_OptionalHeatmapLayerConfigs | nao |  | Set additional parameters to customize the heatmap layer behavior and functionality. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnInitialize, OnParametersChanged, OnReady
- Chama actions do modulo: RemoveHeatmapLayer, GenerateUniqueId, GetHashcode, ChangeHeatmapLayerRadius, LogEvent, ChangeHeatmapLayerOpacity, ChangeHeatmapLayerDissipateOnZoom, DEPRECATED_ChangeHeatmapLayerGradient, ChangeHeatmapLayerMaxIntensity, DEPRECATED_ChangeHeatmapLayerPoints, DEPRECATED_CreateHeatmapLayer (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_HeatmapLayer1","source":"IMobileBlock:DEPRECATED_HeatmapLayer","as":"$b"}
{"op":"set","target":"$b/Points","prop":"Value","value":"<Points List>"}
```

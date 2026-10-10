# FileLayer

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **FileLayer** | publico | 3 widgets internos

The File Layer block allows you to display KML or GeoRSS layers on a map. 
To use it, drag-and-drop the block inside the map’s Addons_Placeholder.

📝 The File Layer is only available for Google Maps.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LayerURL | Text | sim |  | URL of the layer to be displayed on top of the map. The file must be hosted publically. |
| OptionalConfigs | OptionalFileLayerConfigs | nao |  | Set additional parameters to customize the file layer behavior and functionality. |

## Placeholders

Nenhum.

## Eventos

- **OnClick**(MapWidgetId: Text, FileLayerId: Text, LatLng: Coordinates): Event fired every time that the user clicks on the layer.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, Callback_Event, OnReady, OnDestroy, OnParametersChanged, SubscribeEvents
- Chama actions do modulo: GenerateUniqueId, CreateFileLayer, RemoveFileLayer, FileLayerEventUnsubscribe, LogEvent, ChangeFileLayerPreserveViewport, ChangeFileLayerLayerURL, ChangeFileLayerSuppressPopups, FileLayerEventSubscribe (contratos em [actions.md](../actions.md))

## JavaScript

`OnDestroy` / no `GetCallbackHandler`:

```js
$parameters.OnClick_Callback = $actions.Callback_Event
```

`SubscribeEvents` / no `GetCallbackHandler`:

```js
$parameters.OnClick_Callback = $actions.Callback_Event
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"FileLayer1","source":"IMobileBlock:FileLayer","as":"$b"}
{"op":"set","target":"$b/LayerURL","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnClick` resolve o IEventHandler pelo nome do evento e `$b/OnClick/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"FileLayer1_OnClick","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MapWidgetId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"FileLayerId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"LatLng","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Coordinates"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnClick","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnClick/MapWidgetId","prop":"Value","value":"MapWidgetId"}
{"op":"set","target":"$b/OnClick/FileLayerId","prop":"Value","value":"FileLayerId"}
{"op":"set","target":"$b/OnClick/LatLng","prop":"Value","value":"LatLng"}
```

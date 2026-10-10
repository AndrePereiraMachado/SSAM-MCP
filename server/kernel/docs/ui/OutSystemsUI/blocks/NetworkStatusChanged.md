# NetworkStatusChanged

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 5 widgets internos

Triggers different events depending on the device's network connection status.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

- **NetworkStatusChanged**(IsOnline: Boolean)

## Composicao interna

- Ciclo de vida: OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: Online, OnDestroy, Offline, Init, OnReady, DeviceReady
- Chama actions do modulo: LoadOutSystemsUIScript, GetNetworkStatus (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.Network.IsOnline`

`OnDestroy` / no `RemoveEventHandlers`:

```js
document.removeEventListener("offline", $parameters.offlineHandlerObj );
document.removeEventListener("online", $parameters.onlineHandlerObj );
document.removeEventListener("deviceready", $parameters.deviceReadyActionReference);
window.removeEventListener("offline", $parameters.OfflineActionReference);
window.removeEventListener("online",$parameters.OnlineActionReference);
```

`Init` / no `RegisterPluginInfo`:

```js
document.addEventListener("deviceready", $parameters.DeviceReadyActionReference, false);
```

`Init` / no `SaveDeviceReadyCallback`:

```js
$parameters.DeviceReadyActionReference = function(){$actions.DeviceReady();};

```

`Init` / no `SetEventListeners`:

```js
window.addEventListener("offline", $parameters.OfflineActionReference, false);
window.addEventListener("online",$parameters.OnlineActionReference, false);
```

`Init` / no `SetActionReferences`:

```js
$parameters.OfflineActionReference = $actions.Offline;
$parameters.OnlineActionReference = $actions.Online;
```

`OnReady` / no `Init`:

```js
$actions.Init();
```

`DeviceReady` / no `SetEventListeners`:

```js
document.addEventListener("offline", $parameters.OfflineActionReference, false);
document.addEventListener("online", $parameters.OnlineActionReference, false);
```

`DeviceReady` / no `SetActionReferences`:

```js
$parameters.OfflineActionReference = $actions.Offline;
$parameters.OnlineActionReference = $actions.Online;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"NetworkStatusChanged1","source":"IMobileBlock:NetworkStatusChanged","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/NetworkStatusChanged` resolve o IEventHandler pelo nome do evento e `$b/NetworkStatusChanged/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"NetworkStatusChanged1_NetworkStatusChanged","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsOnline","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/NetworkStatusChanged","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/NetworkStatusChanged/IsOnline","prop":"Value","value":"IsOnline"}
```

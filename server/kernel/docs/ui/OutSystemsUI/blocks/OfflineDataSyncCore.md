# OfflineDataSyncCore

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 4 widgets internos

Synchronizes data that can be used offline.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

- **OnSyncComplete**(SyncUnit: Text): Action to execute when when a background offline data sync completes with success.
 
To start a synchronization use the 'TriggerOfflineDataSync' client action, or configure
automatic synchronizations in the 'OfflineDataSyncConfiguration' client action.
- **OnSyncError**(SyncUnit: Text, ErrorMessage: Text): Action to execute when when a background offline data sync fails.
 
To start a synchronization use the 'TriggerOfflineDataSync' client action, or configure
automatic synchronizations in the 'OfflineDataSyncConfiguration' client action.
- **OnSyncStart**(SyncUnit: Text): Action to execute when when a background offline data sync starts.
 
To start a synchronization use the 'TriggerOfflineDataSync' client action, or configure
automatic synchronizations in the 'OfflineDataSyncConfiguration' client action.
- **OnConfigure**()
- **OnSync**(SyncUnit: Text) [obrigatorio]

## Composicao interna

- Usa os blocos: NetworkStatusChanged
- Scripts exigidos: OfflineDataSync
- Ciclo de vida: OnInitialize -> OnInitialize; OnDestroy -> OnDestroy
- Actions do bloco: TriggerOnSyncComplete, Init, OnResume, TriggerOnSyncStart, OnDestroy, TriggerOnSyncError, SyncWrapper, OnInitialize, OnNetworkStatusChanged
- Chama actions do modulo: StartOfflineDataSync, GetNetworkStatus, EndOfflineDataSync (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.Network.IsOnline`

`Init` / no `RegisterAPI`:

```js
$parameters.Token = window.offlineDataSync.registerAPI($actions.SyncWrapper, $actions.OnResume, $actions.TriggerOnSyncStart, $actions.TriggerOnSyncComplete, $actions.TriggerOnSyncError);
```

`OnResume` / no `GetSyncOnResume`:

```js
$parameters.SyncOnResume = window.offlineDataSync.getSyncOnResume();
```

`OnDestroy` / no `UnregisterAPI`:

```js
window.offlineDataSync.unregisterAPI($parameters.Token);
```

`SyncWrapper` / no `SuspendSync`:

```js
window.offlineDataSync.suspendSync();
```

`SyncWrapper` / no `TriggerSyncErrorEventOffline`:

```js
window.offlineDataSync.triggerSyncErrorEvent($parameters.ErrorMessage);
```

`SyncWrapper` / no `TriggerSyncStartEvent`:

```js
window.offlineDataSync.triggerSyncStartEvent();
```

`OnInitialize` / no `Init`:

```js
$actions.Init();
```

`OnNetworkStatusChanged` / no `GetSyncOnOnline`:

```js
$parameters.SyncOnOnline = window.offlineDataSync.getSyncOnOnline();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"OfflineDataSyncCore1","source":"IMobileBlock:OfflineDataSyncCore","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSyncComplete` resolve o IEventHandler pelo nome do evento e `$b/OnSyncComplete/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"OfflineDataSyncCore1_OnSyncComplete","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SyncUnit","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSyncComplete","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSyncComplete/SyncUnit","prop":"Value","value":"SyncUnit"}
```

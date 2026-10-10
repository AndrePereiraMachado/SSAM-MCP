# DisplayOnDevice

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 12 widgets internos

Display content depending on which device is being used. There are placeholders for Phone, Tablet and Desktop.

## Inputs

Nenhum.

## Placeholders

- **OnDesktop**: Add content to be displayed on Desktop (em `Desktop`)
- **OnTablet**: Add content to be displayed on Tablet (em `Tablet`)
- **OnPhone**: Add content to be displayed on Phone (em `Phone`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnReady, OnInitialize
- Chama actions do modulo: GetDeviceType (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.DeviceDetection.GetDeviceType`

`OnDestroy` / no `StopObserver`:

```js
$parameters.ObserverObj.disconnect(); 

```

`OnReady` / no `SetMutationObserver`:

```js
var targetNode = document.body;

// Options for the observer (which mutations to observe)
var config = { attributes: true };

// On mutation, run OnInitialize to update Device variable
var callback = function(){
   $actions.OnInitialize();
};

// Create an observer instance linked to the callback function
var observer = new MutationObserver(callback);

// Start observing the target node for configured mutations
observer.observe(targetNode, config);


$parameters.ObserverObject = observer;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DisplayOnDevice1","source":"IMobileBlock:DisplayOnDevice","as":"$b"}
{"op":"create","parent":"$b/OnDesktop","type":"IExpression","as":"$eOnDesktop"}
{"op":"create","parent":"$b/OnTablet","type":"IExpression","as":"$eOnTablet"}
{"op":"create","parent":"$b/OnPhone","type":"IExpression","as":"$eOnPhone"}
```

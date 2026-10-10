# ApplicationLoadEvents

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 0 widgets internos

Handles the loading progress on a splash screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinimumDisplayTimeMs | Integer | nao | 1000 | Minimum length of time you want to wait before the OnLoadComplete event is called. |

## Placeholders

Nenhum.

## Eventos

- **OnLoadComplete**(RedirectURL: Text): Triggers once the load event is completed.
- **OnUpgradeProgress**(Completed: Integer, Total: Integer): Triggers once the upgrade process event is updated.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnDestroy -> OnDestroy
- Actions do bloco: TriggerOnUpgradeProgress, OnInitialize, OnDestroy, SetTimeoutForLoadComplete, TriggerOnLoadComplete

## JavaScript

`OnInitialize` / no `JSRegisterListeners`:

```js
const start = new Date();

// Check if the app is currently being upgraded
let isUpgrading = $public.ApplicationLifecycle.isUpgradingVersion();

let progressCallback = function(loaded, total) { 
    $actions.TriggerOnUpgradeProgress && $actions.TriggerOnUpgradeProgress(loaded, total); 
};

let finishCallback = function() {
    const elapsedMs = new Date() - start;
    // Calculate the required delay time
    const timeout = Math.max($parameters.MinDisplayTimeMs - elapsedMs, 0);

    // Call the new action with the calculated timeout
    $actions.SetTimeoutForLoadComplete(timeout); 
};

// When there is no upgrade, we need to mimic the progress using the MinDisplayTimeMs
if (!isUpgrading) {
    let loaded = 0;
    const interval = Math.ceil($parameters.MinDisplayTimeMs / 10);

    let timerId = setInterval( function() {
        progressCallback(++loaded, 10);
        if (loaded === 10) {
            clearInterval(timerId);
        }
    }, interval);
    
    // Return the interval ID to be stored
    $parameters.IntervalId = timerId;
}

$public.ApplicationLifecycle.listen({
    // When there is no upgrade, we'll provide the feedback
    onUpgradeProgress: isUpgrading ? progressCallback : null,
    onLoadComplete: finishCallback
});

```

`OnDestroy` / no `JSClearTimeout`:

```js
if($parameters.TimeoutId) {
    clearTimeout($parameters.TimeoutId);
}

if($parameters.IntervalId) {
    clearInterval($parameters.IntervalId);
}

```

`SetTimeoutForLoadComplete` / no `JSSetTimeoutForLoadComplete`:

```js
const timeout = $parameters.TimeoutValueMs; 

let timerId = setTimeout(function() {
    $actions.TriggerOnLoadComplete && $actions.TriggerOnLoadComplete(window.location.href); 
}, timeout);

// Assign the timer ID to the Output Parameter
// OutSystems sees this assignment immediately and persists 'timerId' 
// to the screen's Local Variable before the action completes
$parameters.TimeoutId = timerId;

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ApplicationLoadEvents1","source":"IMobileBlock:ApplicationLoadEvents","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnLoadComplete` resolve o IEventHandler pelo nome do evento e `$b/OnLoadComplete/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ApplicationLoadEvents1_OnLoadComplete","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"RedirectURL","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnLoadComplete","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnLoadComplete/RedirectURL","prop":"Value","value":"RedirectURL"}
```

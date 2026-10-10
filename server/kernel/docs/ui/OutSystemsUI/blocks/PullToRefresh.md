# PullToRefresh

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Private** | publico | 17 widgets internos

Enable swiping down on the screen's content to trigger an action (usually refreshing part of the screen). The Layout already has this Block inside it.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

- **OnContentPull**() [obrigatorio]: Action to execute when users pull to refresh screen data

## Composicao interna

- Scripts exigidos: PullToRefresh
- Ciclo de vida: OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: UpdateStatus, OnReady, OnDestroy, TriggerOnContentPull

## JavaScript

`OnReady` / no `JsInitWebPullToRefresh`:

```js
var loadingFunction = function() {
    return new Promise( function( resolve, reject ) {
        setTimeout(function(){
            $actions.TriggerOnContentPull();
        }, 1000)
        resolve();
    } );
};

WebPullToRefresh.init( {
    // Pointer to function that does the loading and returns a promise
    loadingFunction: loadingFunction,
        
    // Element holding dragable content area
    contentEl: document.querySelector('.content') , 

    // Element holding pull to refresh loading area
    ptrEl: document.getElementById( $parameters.PullToRefreshContainerId ),

    // Element holding pull to refresh a11y area container
    ptrElA11y: document.getElementById( $parameters.PullToRefreshA11YContainerId ),
        
    // Element that contains the scroll bar; leave null if no container with overflow exists
    scrollEl: document.querySelector('.content'),
        
    // Number of pixels of panning until refresh 
    distanceToRefresh: 40,
        
    // Dragging resistance level
    resistance: 2.5,

    // Callback to be used to triger the internal client action that will update the status accordingly
    updateStatusCallback: $actions.UpdateStatus,
});
```

`OnDestroy` / no `JsDestroyWebPullToRefresh`:

```js
WebPullToRefresh.destroy();
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"PullToRefresh1","source":"IMobileBlock:PullToRefresh","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnContentPull` resolve o IEventHandler pelo nome do evento e `$b/OnContentPull/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"PullToRefresh1_OnContentPull","as":"$h"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnContentPull","prop":"Handler","value":"$h"}
```

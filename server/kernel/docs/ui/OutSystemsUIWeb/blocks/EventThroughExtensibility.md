# EventThroughExtensibility

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 13 widgets internos

Block used to allow blocks to have events.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

- **EventFromJS**(param1: Text, param2: Text, param3: Text, param4: Text, param5: Text) [obrigatorio]

## JavaScript

JavaScript do bloco:

```js
function TriggerEvents(blockId) {
    var blk = document.getElementById(blockId);
    var values = Array.prototype.slice.call(arguments, 1);
    values.forEach(function(n,i) {
        var w = blk.querySelector(['[data-p="', i+1, '"]'].join(''));
        if (w) { w.value = n || ""; }
    });
    blk.querySelector('[data-p="btn"]').click();
}
TriggerEvents.cb = {};
TriggerEvents.register = function register(blockId, btnId) {
    TriggerEvents.cb[blockId] = btnId;
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"EventThroughExtensibility1","source":"IWebBlock:EventThroughExtensibility","as":"$b"}
```

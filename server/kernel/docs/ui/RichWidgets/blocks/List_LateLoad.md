# List_LateLoad

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 15 widgets internos

Runs the OnNotify action on first screen load. 
Useful to call an action to populate TableRecord widgets.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: FakeOnNotify
- Chama actions do modulo: JSNotifyWidget, Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_List_LateLoad(containerId) {
  outsystems.internal.$(function($) {
 osAjaxBackend.BindAfterAjaxRequest(function(){
  $("#" + containerId).hide();
  $("._OSLateLoadToRemove").remove();
  });
 });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_LateLoad1","source":"IWebBlock:List_LateLoad","as":"$b"}
```

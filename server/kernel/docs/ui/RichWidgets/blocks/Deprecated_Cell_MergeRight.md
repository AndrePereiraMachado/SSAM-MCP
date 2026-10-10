# Deprecated_Cell_MergeRight

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

DEPRECATED: Use the cell merge in Service Studio instead.

Merges the cells of an EditRecord or ShowRecord to the right. Useful to create section breaks.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_Cell_MergeRight(elementId){
 outsystems.internal.$(function($){
  //set colspan and remove cell at the right
  $('#' + elementId).parents('th,td').eq(0).attr('colSpan',function(){return $(this).nextAll().length + 1}).nextAll().remove();
 });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_Cell_MergeRight1","source":"IWebBlock:Deprecated_Cell_MergeRight","as":"$b"}
```

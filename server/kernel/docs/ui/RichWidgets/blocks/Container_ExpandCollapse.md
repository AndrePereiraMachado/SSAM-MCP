# Container_ExpandCollapse

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 9 widgets internos

Expands and collapses the specified container.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ContainerId | Text | sim |  | The id of the container to expand/collapse |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: jQueryCookie

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_Container_ExpandCollapse_init(expandableId, moreId, lessId){
 outsystems.internal.$().ready(function($) {
  lessId = '#' + lessId;
  moreId = '#' + moreId;
  expandableId = '#' + expandableId;

  if($(expandableId).css('display')!='none'){
   $(lessId).show();
   $(moreId).hide();
  }
  else{
   $(lessId).hide();
   $(moreId).show();
  }
  $(moreId).click(function() {
   $(lessId).show();
   $(moreId).hide();
   $(expandableId).slideToggle();
   
  });
  $(lessId).click(function() {
   $(lessId).hide();
   $(moreId).show();
   $(expandableId).slideToggle();
  });
 });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Container_ExpandCollapse1","source":"IWebBlock:Container_ExpandCollapse","as":"$b"}
{"op":"set","target":"$b/ContainerId","prop":"Value","value":"<Text>"}
```

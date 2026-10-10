# AllowAddToIOSHome

RichWidgets  | Traditional | UI flow **Private** | privado | 4 widgets internos

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Chama actions do modulo: AddMetaTag (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
$(function (){
    //All clicks need to do this so that applications added to iphone home screen will not jump to safari
    if (window.navigator.standalone) {
        $('body').on('click', 'a', function(event){
            /*jshint scripturl:true*/
            var ahref = $(this).attr('href') ? $(this).attr('href').toLowerCase() : "" ;

            // Continue as normally if it is a javascript link, an anchor or mailto: and tel: links
            if (ahref.indexOf('#')!=-1 ||
                event.isDefaultPrevented() ||
                !ahref ||
                this.target ||
                /^(http|https|mailto|tel):/.test(ahref) ||
                (ahref.indexOf('javascript:')===0)) {
              return;
            }
            event.preventDefault();
            window.location = this.href;
        });
    }
});
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"AllowAddToIOSHome1","source":"IWebBlock:AllowAddToIOSHome","as":"$b"}
```

# Deprecated_Container_Round

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 13 widgets internos

DEPRECATED: Design a container with rounded corners using JQuery Curvy Corners by Mike Jolley. 
Only works in Internet Explorer 7 or later, FireFox 3 or later, and Safari.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ContainerId | Text | nao |  | The 'Id' runtime property of the container to have rounded corners. |
| StyleOfContainersToRoundTops | Text | nao |  | If specified, only those widgets with this style have their top corners rounded (e.g. application menus). |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Deprecated_jQueryCurvycorners

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_Container_Round(divId){
    outsystems.internal.$(function($){
        if (!($.browser.msie && $.browser.version<7) && !($.browser.mozilla && $.browser.version.split('.')[0]<=1 && $.browser.version.split('.')[1]<9)) {
            //FF2 and IE6 do not support this
            var container = $('#' + divId);
            if (container.length>0 && container.css('border-top-style')=='none' && container.css('background-color')=='transparent' && container.css("background-image")=='none')
                window.OsHandleException(new Error("The element to apply rounded corners to needs to have a style with a border or a background"), outsystems.osErrorCodes.SystemJavascriptError, 'Container_Round');
            else
                container.corner();
     }
 });
}

function RichWidgets_Container_RoundTops(selector){
    outsystems.internal.$(function($){
        if(!($.browser.msie && $.browser.version<7) && !($.browser.mozilla && $.browser.version.split('.')[0]<=1 && $.browser.version.split('.')[1]<9)) {
            //FF2 and IE6 do not support this
            $(selector).corner({
                tl: { radius: 5 },
                tr: { radius: 5 },
                bl: { radius: 0 },
                br: { radius: 0 }
            });
            if ($.browser.msie && $.browser.version==9) {
                $(selector).css('margin-top','0');
                $(selector).css('margin-bottom','0');
            }
        }
    });
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_Container_Round1","source":"IWebBlock:Deprecated_Container_Round","as":"$b"}
```

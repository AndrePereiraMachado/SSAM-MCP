# RemovePopups

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

Prevents the page from appearing inside a popup.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
outsystems.internal.$(function() {
    if (parent != window){
        var crossDomain;
        try {
            var url = parent.location.href;
            if (parent.location.href == undefined) {
                crossDomain = true;
            } else {
                crossDomain = false;
            }
        } catch (e) {
            crossDomain = true;
        }
        if (crossDomain == false && parent.location.href.indexOf('PreviewInDevices') == -1 ){
            if (parent.RichWidgets_Popup_InfoBalloon_ParentUrl) {
                parent.location = parent.RichWidgets_Popup_InfoBalloon_ParentUrl;
            } else if (parent.RichWidgets_Popup_Editor_ParentUrl) {
                parent.location = parent.RichWidgets_Popup_Editor_ParentUrl;
            } else if (parent.location) {
                parent.location = location.href;
            }
        }
    }
});
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"RemovePopups1","source":"IWebBlock:RemovePopups","as":"$b"}
```

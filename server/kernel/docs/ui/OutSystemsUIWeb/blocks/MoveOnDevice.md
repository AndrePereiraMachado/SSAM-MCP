# MoveOnDevice

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Responsive** | publico | 8 widgets internos

Define the target container for several elements in different devices without duplicating them, i.e. place a search bar on Desktop header but for Tablet and Phone, display on the offcanvas menu.

Place your content on the placeholder and configure where will it be displayed on tablet and phone.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| PhoneWidgetId | Text | nao |  | Target container that will receive this block on phones. |
| TabletWidgetId | Text | nao |  | Target container that will receive this block on tablets. |

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var MoveOnDevice = function() {
    function start(widgetIdParam, TabletWidgetId, PhoneWidgetId) {
        var body = document.querySelector('body');
        var widget = document.getElementById(widgetIdParam);
        var tabletTarget = document.getElementById(TabletWidgetId);
        var phoneTarget = document.getElementById(PhoneWidgetId);
        
        if(body.classList.contains('tablet') && tabletTarget) {
            tabletTarget.appendChild(widget);
        } else if (body.classList.contains('phone') && phoneTarget) {
            phoneTarget.appendChild(widget);
        }
    }

    return {
        init: function(widgetIdParam, TabletWidgetId, PhoneWidgetId) {
            start(widgetIdParam, TabletWidgetId, PhoneWidgetId);
        }
    }

}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"MoveOnDevice1","source":"IWebBlock:MoveOnDevice","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```

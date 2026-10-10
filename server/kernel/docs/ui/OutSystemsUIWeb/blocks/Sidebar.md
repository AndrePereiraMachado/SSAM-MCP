# Sidebar

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 14 widgets internos

Sidebar for additional content on the side of the screen.

Useful to display additional, off-canvas, information.

To trigger the sidebar, call a new screen action through a button with Ajax submit and use the ToggleSidebar action (found in the Logic Tab within OutSystems UI) to open/ close it.
Use the parameters to define if it has Overlay in the page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| HasOverlay | Boolean | nao | False | When set to true enables a clickable overlay. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Header**: Drag your content to this placeholder. (em `SidebarWrapper`)
- **Content**: Drag your content to this placeholder. (em `SidebarWrapper`)

## Eventos

- **OnClickOverlay**(): Event fired on clicking overlay

## Composicao interna

- Usa os blocos: JavaScriptNode
- Actions do bloco: CloseOnOverlay
- Chama actions do modulo: Feedback_Message, HideElement (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var Sidebar = function() {
    
    // Objects
    var SidebarTabIndexItems
    
    var start = function(widgetId) {

        // apply tabindex = -1 by default to disable the navigation inside the sidebar when is hidden
        var SidebarTabIndexItems = document.querySelectorAll("#" + widgetId + " [tabindex]");
        SidebarTabIndexItems = [].slice.call(SidebarTabIndexItems);
        SidebarTabIndexItems.forEach(function(item) {
            item.setAttribute('tabindex', '-1');
        });  
    };

    return {
        init: function(widgetId) {
            start(widgetId);
        }
    };
};
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Sidebar1","source":"IWebBlock:Sidebar","as":"$b"}
{"op":"create","parent":"$b/Header","type":"IExpressionWidget","as":"$eHeader"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```

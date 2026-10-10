# Modal

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Content** | publico | 13 widgets internos

The Modal is a dialog box/popup window that is displayed on top of the current page. It can have custom content that is displayed as an overlay in the page. Has placeholders for Title, Content and Footer.

Useful to display additional, off-canvas, information.

To trigger the modal, call a new screen action through a button with Ajax submit and use the ToggleModal action (found in the Logic Tab within OutSystems UI) to open/ close it.
Use the parameters to define if it has Overlay, its Position in the page and the Enter/Leave Animation.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | PositionExtended Identifier | nao | Entities.PositionExtended.Center | Set the position of the Modal on the screen. |
| HasOverlay | Boolean | nao | True | When true, an overlay is enabled behind the modal. |
| EnterAnimation | EnterAnimation Identifier | nao | Entities.EnterAnimation.EnterScale | Set the enter animation. |
| LeaveAnimation | LeaveAnimation Identifier | nao | Entities.LeaveAnimation.LeaveScale | Set the leave animation. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

Valores possiveis (static entities):

- **Entities.PositionExtended**: TopLeft, TopRight, TopCenter, BottomRight, Center, CenterLeft, CenterRight, BottomCenter, BottomLeft
- **Entities.EnterAnimation**: EnterFade, EnterScale, EnterTop, EnterRight, EnterBottom, EnterLeft
- **Entities.LeaveAnimation**: LeaveBottom, LeaveScale, LeaveFade, LeaveLeft, LeaveTop, LeaveRight

## Placeholders

- **Content**: Drag your content to this placeholder. (em `ModalWrapper`)
- **Footer**: Use this placeholder to set your footer. (em `ModalWrapper`)
- **Title**: Use this placeholder to set your title. (em `ModalWrapper`)
- **Icon**: Drag the Icon widget to this placeholder. (em `ModalWrapper`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
var Modal = function() {
    
    // Objects
    var ModalTabIndexItems
    
    var start = function(widgetId) {

        // apply tabindex = -1 by default to disable the navigation inside the modal when is hidden
        ModalTabIndexItems = document.querySelectorAll("#" + widgetId + " [tabindex]");
        ModalTabIndexItems = [].slice.call(ModalTabIndexItems);
        ModalTabIndexItems.forEach(function(item) {
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
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Modal1","source":"IWebBlock:Modal","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
{"op":"create","parent":"$b/Footer","type":"IExpressionWidget","as":"$eFooter"}
{"op":"create","parent":"$b/Title","type":"IExpressionWidget","as":"$eTitle"}
{"op":"create","parent":"$b/Icon","type":"IExpressionWidget","as":"$eIcon"}
```

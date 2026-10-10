# Popup_EditorForUpload

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 14 widgets internos

Opens the specified link on a modal pop-up that can have editable screens.
Actions PopUpEditor_Close and PopUpEditor_Notify can be used to send information to the parent screen.
If WidthPx and HeightPx are not specified the popup will auto-resize to contents. 
Refresh the pop-up whenever the link is refreshed to keep them working accordingly.
Not supported in mobile devices.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| LinkOrButtonWidgetId | Text | sim |  | The link or button id to open in the pop-up. |
| Title | Text | nao | " " | Title for the pop-up window. |
| WidthPx | Integer | nao | -1 | The width of the pop-up window. When not set it will automatically resize to fit contents. |
| HeightPx | Integer | nao | -1 | The height of the pop-up window. When not set it will automatically resize to fit contents. |
| AutoResize | Boolean | nao | True | When set to True, the popup will be resized after each Ajax refresh. The default is True. |
| RecenterOnResize | Boolean | nao | False | When set to True, the popup will be recentered when it is resized after an Ajax refresh. The default is False. |
| HideCloseButton | Boolean | nao | False |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: RichWidgetsjQueryUI
- Actions do bloco: FakeOnNotify, GenerateUploadToken
- Chama actions do modulo: Deprecated_Notify, CreateUploadToken (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
//Open an Dialog
var RichWidgets_Popup_Editor_ShowTimeoutMilSecs = 200;
var RichWidgets_Popup_Editor_HideTimeoutMilSecs = 800;
var RichWidgets_Popup_Editor_InitialWidth = 210;
var RichWidgets_Popup_Editor_InitialHeight = 100;
var RichWidgets_Popup_Editor_notifyWidget;
var RichWidgets_Popup_Editor_Index = 4010;
var RichWidgets_Popup_Editor_ParentUrl;
var RichWidgets_Popup_Editor_ClosingTag = 'closing';
var RichWidgets_Popup_Editor_ClosingValue = 'true';

function RichWidgets_Popup_Editor_resize(divToPopup, setWidth, setHeight, recenter, event) {
    // Code to support old resize method RichWidgets_Popup_Editor_resize(setWidth, setHeight, recenter)
    if(typeof(recenter) == 'undefined') {
        recenter = setHeight;
        setHeight = setWidth;
        setWidth = divToPopup;
        divToPopup = outsystems.internal.$('.os-internal-ui-dialog-content');
    }
    
    
    // Resize must bail out immediately if the popup is marked as closing, and not start the animation.
    if(outsystems.internal.$.data(divToPopup.get(0), RichWidgets_Popup_Editor_ClosingTag) == RichWidgets_Popup_Editor_ClosingValue) {
        return false;
    }
    var frameObj = divToPopup.find('iframe')[0];
    var documentServer = document.location.href.replace(/(https?:\/\/[^\/]*).*/, '$1');
    var frameServer = frameObj.src.replace(/(https?:\/\/[^\/]*).*/, '$1');
    var sameOrigin = (frameServer.toLowerCase() == documentServer.toLowerCase() || frameServer.indexOf("http") != 0);
    if (!sameOrigin && (setWidth == -1 || setHeight == -1)) throw (new Error("A Popup with a screen from a different server (or https) needs explicict width, height set."));
    if (sameOrigin) {
        var innerDoc = (frameObj.contentDocument) ? frameObj.contentDocument : frameObj.contentWindow.document;
        if (innerDoc.documentElement.scrollHeight == 0) // strangely this event is also triggered on close
        return false;
    }
    var oldHeight = outsystems.internal.$(divToPopup).parents('.os-internal-Popup').outerHeight();
    var width = ((setWidth == -1) ? outsystems.internal.$(innerDoc).width() : setWidth);
    var height = ((setHeight == -1) ? outsystems.internal.$(innerDoc).height() : setHeight);

    var titleHeight = outsystems.internal.$('.os-internal-ui-dialog-titlebar').height();
    
    // Verify if the parent window width is less than the pop-up window, if so set the responsive class on the iframe body (for responsive themes)
    if(window.innerWidth < width)
    {
        // only set the class if the origin is the same
        if(sameOrigin) {
            $(innerDoc).find('body').addClass('Responsive');
            width = window.innerWidth - 20; // 10px "padding" effect, to keep the popup look and feel on top of content
        }
    }

    // Fix issues with scrollbars
    if (setHeight == -1) {
        // IE7 needs a little more space to remove the scrollbars
        if (outsystems.internal.$.browser.msie) height = height + 1;
    } else { //when explicitly setting the height
        if (sameOrigin) innerDoc.body.style.height = 'auto';
    }

    outsystems.internal.$(divToPopup).height(height);


    //Hide ECT
    outsystems.internal.$(innerDoc).find('.ECT_FeedbackContainer').hide();
    var divPopupOuterWindow = outsystems.internal.$(divToPopup).parents('.os-internal-Popup');

    var animateFinal = {};

    if (setHeight == -1) {
        var oldTop = parseInt(divPopupOuterWindow.css("top"));
        if (recenter)
            animateFinal.top = Math.max(20, oldTop + (oldHeight - (height + titleHeight)) / 2);
        animateFinal.height = height + titleHeight;
    }

    if (setWidth == -1) {
        var oldLeft = parseInt(divPopupOuterWindow.css("left"));
        if (recenter)
            animateFinal.left = oldLeft + (divPopupOuterWindow.width() - width) / 2;
        animateFinal.width = width;
    }
    
    if(divPopupOuterWindow.width() == animateFinal.width && 
       divPopupOuterWindow.height() == (animateFinal.height - (outsystems.internal.$.browser.msie?1:0))){
       outsystems.internal.$(".os-internal-ui-dialog-content>.Text_Note").hide();
       outsystems.internal.$(divToPopup).height(height - (outsystems.internal.$.browser.msie?1:0)); // restore size
       return true; // nothing to do...
    }
    
    // hide content in first resize - readjustments will not flickr
    if(divPopupOuterWindow.width()  == RichWidgets_Popup_Editor_InitialWidth && 
       divPopupOuterWindow.height() == RichWidgets_Popup_Editor_InitialHeight){
        outsystems.internal.$(frameObj).height(0);
    }
    var onAnimationComplete = function () {
        setTimeout(function() {
            outsystems.internal.$(divToPopup).dialog('size');
            outsystems.internal.$('.os-internal-ui-dialog-titlebar-close-no-title').css('display', 'block');
            outsystems.internal.$(divToPopup).find('iframe').height("100%").width(animateFinal.width);
        },13);
    };
    var divPleaseWait = outsystems.internal.$(".os-internal-ui-dialog-content>.Text_Note");
    divPleaseWait.hide();

    if (setHeight == -1 || setWidth == -1) divPopupOuterWindow.animate(animateFinal, {
        duration: 200,
        complete: onAnimationComplete
    });
    else onAnimationComplete();

    innerDoc = null;
    divPopupOuterWindow = null;
    outsystems.internal.$.data(event.target,"os-internal-processing", false);
    return true;
}

var popupToClose;
function RichWidgets_Popup_Editor_Close(iFrame) {
    // Any close requests must immediately (synchronously) tag the closing element, marking it as closing. The cleanup must be done asynchronously due to IE7..
    popupToClose = outsystems.internal.$('.os-internal-ui-dialog-content');
    outsystems.internal.$(popupToClose).data(RichWidgets_Popup_Editor_ClosingTag, RichWidgets_Popup_Editor_ClosingValue);

    function WaitForJSONUpdateAndAJAX(continuation) {
        var hasPendingAJAX = false;
        var hasPendingJSONUpdate = false;
        try {
            hasPendingAJAX = popupT
/* ... truncado: 9670 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Popup_EditorForUpload1","source":"IWebBlock:Popup_EditorForUpload","as":"$b"}
{"op":"set","target":"$b/LinkOrButtonWidgetId","prop":"Value","value":"<Text>"}
```
